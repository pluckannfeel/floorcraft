"""Upload validation pipeline for ObjectVariant files (U2, object-visuals).

Pure, importable helpers — no Django models, no views — so the reject/accept
matrix (the feature's security surface, per U2's execution note) is testable
without HTTP plumbing. The serializer calls these in order:

    check_extension  ->  check_byte_cap  ->  process_upload

`process_upload` sniffs magic bytes and branches:

  raster (PNG/JPEG):  Pillow verify -> EXIF transpose -> mode normalize ->
                      dimension caps -> re-encode to a fresh buffer
  SVG:                DOCTYPE/ENTITY pre-reject -> our hardened reject-scan ->
                      py-svg-hush filtering -> viewBox/dimension normalize

Why OUR OWN reject-scan exists (the plan's svg-hush finding): py-svg-hush
CANNOT reject — verified empirically against the 0.3.0 wheel, its API only
silently strips active content, and clean-input roundtrips are non-identical
so stripping is undetectable by diff. R9 demands a *friendly rejection that
explains why*, which only a scan that can say "no, because <script>" can
deliver. svg-hush therefore runs AFTER our scan, filtering already-accepted
input as defense-in-depth; ITS output is what gets stored.

Abuse bounds (R19): the quota constants here are aggregated atomically by
the viewset at create time (soft-deleted variants INCLUDED — their files
persist on disk, the plan's retention stance), and VariantUploadThrottle
rate-limits the upload action so an authenticated user cannot burn CPU
(Pillow + svg-hush both cost real work per request) or fill the disk.
"""

import math
import re
import unicodedata
import xml.etree.ElementTree as ET
from collections import namedtuple
from io import BytesIO

from PIL import Image, ImageOps
from py_svg_hush import filter_svg
from rest_framework.throttling import SimpleRateThrottle

# ---------------------------------------------------------------------------
# Limits (module constants — the serializer, viewset, and tests all import
# these so there is exactly one source of truth for every bound).
# ---------------------------------------------------------------------------

# Per-format byte caps (R9), enforced BEFORE any expensive work: the
# serializer checks the upload's reported size before even reading the bytes,
# and the pipeline re-checks authoritatively on the actual data (covering an
# SVG smuggled in under a raster extension's larger cap).
MAX_RASTER_BYTES = 5 * 1024 * 1024  # 5 MB — PNG/JPEG
MAX_SVG_BYTES = 1 * 1024 * 1024     # 1 MB — SVG

# Dimension caps. Raster pixels cost memory to decode (8000x8000 RGBA is
# already ~256 MB decompressed — Pillow's default decompression-bomb guard
# stays enabled as the backstop above that). SVG "natural" dimensions are
# just attacker-controlled numbers flowing into the frontend's aspect-fit
# drop math, so they get the same validate-and-clamp treatment with a looser
# ceiling (they cost nothing to "decode", but NaN/1e300 must never reach the
# canvas geometry).
MAX_RASTER_DIMENSION = 8000
MAX_SVG_DIMENSION = 20000

# Per-user quota (R19): count and total stored bytes, soft-deleted variants
# included (files are never removed from disk in v1 — the plan's retention
# stance — so quota must track what storage actually holds).
MAX_VARIANT_COUNT = 100
MAX_VARIANT_TOTAL_BYTES = 100 * 1024 * 1024  # 100 MiB

ALLOWED_EXTENSIONS = {'svg', 'png', 'jpg', 'jpeg'}

SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

# Registered once so a re-serialized (viewBox-normalized) SVG keeps the
# default namespace on its root instead of an ugly-but-valid ns0: prefix.
ET.register_namespace('', SVG_NAMESPACE)
ET.register_namespace('xlink', 'http://www.w3.org/1999/xlink')

# ---------------------------------------------------------------------------
# Rejection messages — SPECIFIC, human, and distinct per failure class
# (format vs size vs active-content vs DOCTYPE vs quota), matching the
# origin's "a rejected upload explains why" (R9). Tests assert on these, and
# the active-content/DOCTYPE wording doubles as proof that a rejection came
# from OUR scan — svg-hush has no reject path and produces no messages.
# ---------------------------------------------------------------------------

MSG_BAD_EXTENSION = (
    'Unsupported file type. Please upload an SVG, PNG, or JPEG image '
    '(.svg, .png, .jpg, or .jpeg).'
)

# The "format message": the file claimed to be an image but could not be
# read as one. Also used for degenerate/enormous dimensions (per the plan's
# U2 amendment: dimension failures are format-category rejections — the file
# as exported is unusable, so the fix is the same "re-export it").
MSG_NOT_AN_IMAGE = (
    "We couldn't read that file as an SVG, PNG, or JPEG image. "
    'Please re-export it and try again.'
)

MSG_RASTER_TOO_BIG = 'That image is too large. PNG and JPEG uploads are limited to 5 MB.'
MSG_SVG_TOO_BIG = 'That SVG is too large. SVG uploads are limited to 1 MB.'

# Dedicated DOCTYPE message (NOT the generic format message): a benign
# W3C-DTD export and a billion-laughs bomb are indistinguishable without
# parsing, and parsing is exactly what we must not do — so both get the
# same actionable instruction.
MSG_DOCTYPE = (
    'This SVG contains a DOCTYPE declaration, which we cannot accept — '
    'please remove the DOCTYPE declaration and re-export the file.'
)

# Friendly active-content rejection naming what was found (filled via
# .format(found=...)).
MSG_ACTIVE_CONTENT = (
    'This SVG contains active content ({found}), which we cannot accept. '
    'Please export a plain, graphics-only SVG and try again.'
)

MSG_QUOTA = (
    "You've reached your upload limit — accounts are limited to "
    '100 uploads and 100 MB of storage in total, and deleted uploads '
    'still count. Please remove unused files from your account plan '
    'or contact support.'
)


class VariantRejected(Exception):
    """Raised anywhere in the pipeline; str(exc) is the user-facing message.

    The serializer converts this to a DRF ValidationError on the `file`
    field, so every rejection surfaces as a 400 with a specific, friendly
    explanation (R9).
    """


# What an accepted upload boils down to: the exact bytes to store (NEVER the
# client's original bytes for rasters — see _process_raster), the sniffed
# kind, and the validated natural dimensions recorded on the row.
ProcessedUpload = namedtuple('ProcessedUpload', ['kind', 'content', 'width', 'height'])


# ---------------------------------------------------------------------------
# Entry points (called by the serializer, in this order)
# ---------------------------------------------------------------------------

def check_extension(filename):
    """Extension allowlist — the CHEAPEST gate, so it runs first (R9).

    The extension is never trusted for anything downstream (the sniff is
    authoritative; storage paths derive from the sniffed kind — see
    models.variant_upload_to); it exists to reject obviously-wrong files
    with a clear message before any bytes are read, and to select which
    byte cap applies in check_byte_cap.
    """
    name = filename or ''
    if '.' not in name:
        raise VariantRejected(MSG_BAD_EXTENSION)
    extension = name.rsplit('.', 1)[1].lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise VariantRejected(MSG_BAD_EXTENSION)
    return extension


def check_byte_cap(extension, size):
    """Per-format byte cap on the upload's REPORTED size (R9), enforced
    before the serializer reads the bytes into memory — expensive work
    (Pillow decode, svg-hush parse) must never start on an oversize body.
    The pipeline re-checks the cap on the actual byte count, so lying here
    buys nothing.
    """
    if extension == 'svg':
        if size > MAX_SVG_BYTES:
            raise VariantRejected(MSG_SVG_TOO_BIG)
    elif size > MAX_RASTER_BYTES:
        raise VariantRejected(MSG_RASTER_TOO_BIG)


def process_upload(data):
    """Sniff the actual content and run the matching pipeline branch.

    Magic bytes decide the branch — never the extension or Content-Type
    (both are client-controlled lies waiting to happen). SVG has no magic
    number: it is classified as "text that is not a raster", and earns the
    'svg' kind only if the full SVG content-check (pre-reject + hardened
    scan + svg-hush) passes.
    """
    kind = _sniff_raster_kind(data)
    if kind is not None:
        return _process_raster(data, kind)
    return _process_svg(data)


def clean_original_name(name, fallback):
    """Sanitize the upload's client-supplied display name (R12).

    `original_name` round-trips through the list API into tooltips/aria
    labels, so control characters (Unicode category Cc: NUL, ESC, CR/LF,
    DEL, C1 block...) are stripped and the result is capped at the model
    field's 255. It is DISPLAY-ONLY — the storage path never sees it
    (models.variant_upload_to ignores filenames entirely).
    """
    cleaned = ''.join(
        char for char in (name or '') if unicodedata.category(char) != 'Cc'
    ).strip()
    if not cleaned:
        # A name that was ALL control characters (or empty) still needs a
        # human-readable label in the catalog strip.
        cleaned = fallback
    return cleaned[:255]


def variant_file_url(variant_id):
    """The variant's authenticated file endpoint, by URL convention.

    U3 owns the REAL route (`/api/object-variants/<id>/file/` as a viewset
    action) — it lands next, so this deliberately builds the string instead
    of reverse()-ing a route that does not exist yet. The convention is
    fixed by the plan (U3's serving contract), making this a forward
    reference, not a guess.
    """
    return f'/api/object-variants/{variant_id}/file/'


class VariantUploadThrottle(SimpleRateThrottle):
    """Per-user rate limit on the upload action ONLY (R19).

    Self-contained by design: `scope` and `rate` are hardcoded here rather
    than wired through settings.DEFAULT_THROTTLE_RATES — keeping settings.py
    out of U2's blast radius (SimpleRateThrottle only consults settings when
    the class has no `rate` of its own). The default LocMemCache backs the
    history, which is fine for this single-process deployment.

    Uploads burn real CPU per request (Pillow decode/re-encode, svg-hush
    parse), so unlike list/destroy they are a DoS lever even inside quota —
    20/min is generous for a human curating a catalog and hostile to a loop.
    """

    scope = 'variant-upload'
    rate = '20/min'

    def get_cache_key(self, request, view):
        if request.user and request.user.is_authenticated:
            ident = request.user.pk
        else:
            # Unreachable in practice (IsAuthenticated runs before
            # throttling), but fall back to the client address rather than
            # sharing one global anonymous bucket.
            ident = self.get_ident(request)
        return self.cache_format % {'scope': self.scope, 'ident': ident}


# ---------------------------------------------------------------------------
# Raster branch (PNG / JPEG)
# ---------------------------------------------------------------------------

PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
# JPEG: SOI marker + the 0xFF of the next marker. This prefix also matches
# MPO (Multi-Picture Object) files — the multi-frame JPEG container phone
# cameras commonly emit. Pillow reports those as format 'MPO', and we treat
# them as JPEG throughout (see _EXPECTED_PIL_FORMATS).
JPEG_SIGNATURE = b'\xff\xd8\xff'

# Pillow formats acceptable per sniffed kind. MPO rides the jpeg branch:
# same bytes-level signature, same decoder family, and our re-encode
# collapses it to a plain single-frame JPEG anyway.
_EXPECTED_PIL_FORMATS = {
    'png': {'PNG'},
    'jpeg': {'JPEG', 'MPO'},
}


def _sniff_raster_kind(data):
    """Magic-byte sniff for the two raster kinds; None means 'not a raster'
    (the SVG branch then decides whether it is anything at all).
    """
    if data.startswith(PNG_SIGNATURE):
        return 'png'
    if data.startswith(JPEG_SIGNATURE):
        return 'jpeg'
    return None


def _process_raster(data, kind):
    """Validate and RE-ENCODE a raster upload (R9 + upload-security
    consensus). The stored bytes are always a fresh Pillow encode — never
    the client's original buffer — which simultaneously:

      * kills polyglots (a PNG with an HTML/script payload smuggled after
        IEND does not survive re-encoding — the trailing bytes are simply
        never read);
      * strips ALL metadata, EXIF included (we re-encode without passing
        any, so GPS coordinates etc. never reach disk);
      * normalizes the color mode (CMYK JPEGs invert in some browsers;
        everything becomes RGB, or RGBA where PNG transparency exists).

    Order matters: ImageOps.exif_transpose runs FIRST, then the re-encode
    drops the metadata — transpose-after-strip would lose the orientation
    tag before applying it, and every sideways phone photo would render
    sideways forever. The recorded dimensions are POST-transpose for the
    same reason (the frontend's aspect-fit math needs the upright shape).
    """
    # Authoritative cap on the actual byte count (the serializer's earlier
    # check used the upload's reported size).
    if len(data) > MAX_RASTER_BYTES:
        raise VariantRejected(MSG_RASTER_TOO_BIG)

    try:
        # Pass 1 — structural verification. Image.open is lazy (header
        # only), so the dimension cap is checked BEFORE any pixel decoding:
        # an absurd-dimension file is rejected without ever paying its
        # decode cost. Pillow's default decompression-bomb guard
        # (MAX_IMAGE_PIXELS) is deliberately left enabled as the backstop.
        with Image.open(BytesIO(data)) as probe:
            if probe.format not in _EXPECTED_PIL_FORMATS[kind]:
                # Magic bytes said PNG/JPEG but Pillow decoded something
                # else — a mismatch this deep is a malformed/hostile file.
                raise VariantRejected(MSG_NOT_AN_IMAGE)
            probe_width, probe_height = probe.size
            if not (1 <= probe_width <= MAX_RASTER_DIMENSION
                    and 1 <= probe_height <= MAX_RASTER_DIMENSION):
                # Dimension failures use the format message — see
                # MSG_NOT_AN_IMAGE's comment.
                raise VariantRejected(MSG_NOT_AN_IMAGE)
            # verify() walks the file structure for corruption; it leaves
            # the object unusable, hence the re-open below.
            probe.verify()

        # Pass 2 — the actual decode + normalize + re-encode.
        image = Image.open(BytesIO(data))

        # Animated inputs (APNG, multi-frame MPO/GIF-style): Pillow opens
        # positioned on frame one, and saving without save_all keeps ONLY
        # that frame. This is an explicit contract, not an accident — a
        # variant is a static catalog visual.
        image = ImageOps.exif_transpose(image)  # FIRST — see docstring.
        width, height = image.size  # POST-transpose (upright) dimensions.

        if kind == 'jpeg':
            # JPEG has no alpha; RGB normalizes CMYK/greyscale/palette.
            image = image.convert('RGB')
        elif image.mode in ('RGBA', 'LA', 'PA') or (
            image.mode == 'P' and 'transparency' in image.info
        ):
            # PNG keeps transparency where it genuinely exists...
            image = image.convert('RGBA')
        else:
            # ...and everything else flattens to plain RGB.
            image = image.convert('RGB')

        # Fresh buffer, fresh encode: THE polyglot/EXIF kill step. No
        # `exif=`/metadata kwargs are passed, so none survive.
        out = BytesIO()
        if kind == 'jpeg':
            image.save(out, format='JPEG', quality=90)
        else:
            image.save(out, format='PNG')
    except VariantRejected:
        raise
    except Exception:
        # Pillow raises a small zoo (UnidentifiedImageError, OSError on
        # truncation, DecompressionBombError, ValueError...) — every one of
        # them means "this is not a usable image", which is exactly the
        # format message.
        raise VariantRejected(MSG_NOT_AN_IMAGE)

    return ProcessedUpload(kind=kind, content=out.getvalue(), width=width, height=height)


# ---------------------------------------------------------------------------
# SVG branch
# ---------------------------------------------------------------------------

def _process_svg(data):
    """The full SVG pipeline: classify -> pre-reject -> hardened scan ->
    svg-hush -> dimension normalize. Every step below is ordered ON PURPOSE;
    see the per-step comments.
    """
    # Authoritative SVG byte cap (also catches an SVG that arrived under a
    # raster extension and therefore only met the 5 MB check earlier).
    if len(data) > MAX_SVG_BYTES:
        raise VariantRejected(MSG_SVG_TOO_BIG)

    # --- "Is this even text?" -------------------------------------------
    # SVG classification = text that is NOT a raster. Two checks with a
    # shared security purpose:
    #   * NUL bytes are rejected outright. Real UTF-8 SVG never contains
    #     them, and every UTF-16 encoding of ASCII markup is FULL of them —
    #     this closes the encoding-smuggle where a file that scans clean as
    #     UTF-8 carries an XML declaration steering the parser to decode it
    #     as UTF-16, revealing a DOCTYPE our byte-scan never saw.
    #   * The bytes must decode as UTF-8. With both guarantees, the decoded
    #     text and the bytes expat parses are the SAME characters, so the
    #     pre-reject scan below cannot be bypassed by re-interpretation.
    if b'\x00' in data:
        raise VariantRejected(MSG_NOT_AN_IMAGE)
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        raise VariantRejected(MSG_NOT_AN_IMAGE)

    # --- DOCTYPE/ENTITY pre-reject: the entity-bomb defusal --------------
    # This is a plain substring scan and it MUST run before any XML parse:
    # a stdlib parse at the sniff stage would itself be the detonation
    # point for a billion-laughs/quadratic-blowup payload (expat expands
    # entities as it reads). Legitimate SVG exports do not need DTDs, so
    # ANY DOCTYPE — the benign W3C-DTD boilerplate included — gets the
    # dedicated, actionable message rather than the generic format error.
    # Case-insensitive out of pure paranoia (XML mandates uppercase, but a
    # scan this cheap has no business assuming a well-behaved producer).
    lowered = text.lower()
    if '<!doctype' in lowered or '<!entity' in lowered:
        raise VariantRejected(MSG_DOCTYPE)

    # --- Parse (now entity-safe) -----------------------------------------
    # With the pre-reject done, stdlib ElementTree parsing is entity-safe:
    # no DOCTYPE means no place to DECLARE an entity, so expat can at most
    # meet the five predefined XML entities (&amp; &lt; ...), which do not
    # expand recursively. The historical "stdlib XML is vulnerable" advice
    # is about entity DECLARATIONS — exactly what can no longer be present.
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        raise VariantRejected(MSG_NOT_AN_IMAGE)

    # The root must be a NAMESPACED <svg>. A bare un-namespaced <svg> is
    # not a rendering SVG in any XML context (browsers require the
    # namespace), and svg-hush hard-errors on it anyway — rejecting here
    # keeps the message ours and specific.
    if root.tag != f'{{{SVG_NAMESPACE}}}svg':
        raise VariantRejected(MSG_NOT_AN_IMAGE)

    # --- OUR reject-scan (the plan's svg-hush finding) --------------------
    # svg-hush cannot reject — it only silently strips (verified against
    # the 0.3.0 wheel; a stripped upload would "succeed" while quietly
    # losing content, the exact opposite of R9's friendly rejection). So
    # active content is OUR call, made here, with a message naming the find.
    _scan_svg_tree(root)

    # --- svg-hush: defense-in-depth on ACCEPTED input ---------------------
    # Runs after our scan, and ITS output is what gets stored: anything our
    # scan has no rule for (CSS imports, data: URLs — kept at svg-hush's
    # default strip policy per the plan, animation timing, etc.) gets
    # filtered out belt-and-suspenders style.
    try:
        hushed = filter_svg(data)
    except Exception:
        # svg-hush is Rust behind a thin binding; any parse/filter error on
        # input WE accepted still just means "not a usable SVG".
        raise VariantRejected(MSG_NOT_AN_IMAGE)

    return _normalize_svg_dimensions(hushed)


# Element localnames that ARE active content, namespace-agnostic: a script
# is a script whether it claims the SVG, XHTML, or no namespace at all.
_ACTIVE_ELEMENTS = {
    'script': 'a <script> element',
    'foreignobject': 'a <foreignObject> element',
}

# Attributes whose values can reference external resources via url(...).
# The plan names style/fill; internal fragment references (url(#gradient))
# are the legitimate use and stay allowed.
_URL_BEARING_ATTRIBUTES = {'style', 'fill'}


def _localname(qualified):
    """'{http://ns}tag' -> 'tag' (ElementTree's Clark notation)."""
    return qualified.rsplit('}', 1)[-1]


def _scan_svg_tree(root):
    """Walk every element/attribute and reject on the plan's active-content
    list: script elements, on* event-handler attributes, foreignObject, any
    href/xlink:href that is not a fragment, and url(...) references to
    external resources in style/fill values. All matches are on LOCALNAMES
    (namespace-agnostic) and case-insensitive — an attacker picks the
    weirdest spelling their target renderer accepts, so we match the
    broadest spelling we can.
    """
    for element in root.iter():
        if not isinstance(element.tag, str):
            continue  # comments/PIs are dropped by the default parser; belt-and-suspenders.
        tag = _localname(element.tag).lower()
        if tag in _ACTIVE_ELEMENTS:
            raise VariantRejected(MSG_ACTIVE_CONTENT.format(found=_ACTIVE_ELEMENTS[tag]))

        for raw_name, value in element.attrib.items():
            name = _localname(raw_name).lower()
            if name.startswith('on'):
                # onload/onclick/onmouseover/... — script by another door.
                # (No legitimate SVG attribute starts with "on".)
                raise VariantRejected(
                    MSG_ACTIVE_CONTENT.format(found=f'an event-handler attribute ({name})')
                )
            if name == 'href' and not value.strip().startswith('#'):
                # Covers both href and xlink:href (same localname). Only
                # same-document fragments are ever legitimate in a static
                # catalog visual; everything else exfiltrates or embeds.
                raise VariantRejected(
                    MSG_ACTIVE_CONTENT.format(found='an external href reference')
                )
            if name in _URL_BEARING_ATTRIBUTES and _has_external_url_reference(value):
                raise VariantRejected(
                    MSG_ACTIVE_CONTENT.format(found=f'an external url() reference in {name}')
                )


def _has_external_url_reference(value):
    """True when a style/fill value contains url(...) pointing anywhere but
    a same-document fragment (#id). Quotes and whitespace inside url() are
    tolerated; a url( with no closing paren is malformed enough to count as
    external (fail closed).
    """
    lowered = value.lower()
    position = 0
    while True:
        position = lowered.find('url(', position)
        if position == -1:
            return False
        closing = value.find(')', position)
        if closing == -1:
            return True
        target = value[position + 4:closing].strip().strip('\'"').strip()
        if not target.startswith('#'):
            return True
        position = closing + 1


def _normalize_svg_dimensions(hushed):
    """Ensure the STORED root carries absolute width/height, and record the
    validated natural dimensions.

    Firefox draws an SVG loaded as an <img>/Image() BLANK when the root has
    no width/height (it will not infer them from the viewBox) — so when the
    upload only has a viewBox, absolute dimensions are derived from it and
    written onto the root before storing. Runs on svg-hush's OUTPUT because
    that is what gets stored (normalizing pre-hush would risk the fix being
    rewritten away).

    The recorded ints get the validate-and-clamp treatment (positive,
    finite, <= MAX_SVG_DIMENSION per side): viewBox numbers are attacker-
    controlled and flow straight into the frontend's aspect-fit drop math,
    so 0/negative/NaN/1e300 are rejected (format message — the export is
    unusable as-is) rather than laundered into canvas geometry.
    """
    try:
        root = ET.fromstring(hushed)
    except ET.ParseError:
        raise VariantRejected(MSG_NOT_AN_IMAGE)

    width = _parse_length(root.get('width'))
    height = _parse_length(root.get('height'))
    if width is not None and height is not None:
        # Root already carries usable absolute dimensions: store svg-hush's
        # bytes VERBATIM (no re-serialization to introduce drift), just
        # validate/clamp what we record.
        return ProcessedUpload(
            kind='svg',
            content=hushed,
            width=_clamp_dimension(width),
            height=_clamp_dimension(height),
        )

    # No usable width/height (absent, percentage, or non-px units): derive
    # both from the viewBox — the Firefox blank-render fix.
    view_box = root.get('viewBox')
    if view_box is None:
        raise VariantRejected(MSG_NOT_AN_IMAGE)
    parts = re.split(r'[\s,]+', view_box.strip())
    if len(parts) != 4:
        raise VariantRejected(MSG_NOT_AN_IMAGE)
    try:
        box_width, box_height = float(parts[2]), float(parts[3])
    except ValueError:
        raise VariantRejected(MSG_NOT_AN_IMAGE)

    clamped_width = _clamp_dimension(box_width)
    clamped_height = _clamp_dimension(box_height)
    root.set('width', str(clamped_width))
    root.set('height', str(clamped_height))
    content = ET.tostring(root, encoding='utf-8')  # includes the XML declaration
    return ProcessedUpload(kind='svg', content=content, width=clamped_width, height=clamped_height)


def _parse_length(value):
    """Parse an SVG length attribute into a float, or None when it cannot
    yield an ABSOLUTE pixel value (absent, percentages, cm/em/..., or
    non-numeric junk — those fall through to viewBox derivation). Accepts
    unitless numbers and an explicit px suffix only.
    """
    if value is None:
        return None
    text = value.strip().lower()
    if text.endswith('px'):
        text = text[:-2].strip()
    try:
        number = float(text)
    except ValueError:
        return None
    if not math.isfinite(number):
        return None  # float() happily parses 'nan'/'inf' — not dimensions.
    return number


def _clamp_dimension(value):
    """Validate + clamp one natural dimension to a positive int within the
    SVG ceiling; anything degenerate (non-finite, zero, negative, enormous)
    rejects with the format message. Fractional-but-valid values round to
    the nearest pixel, floored at 1.
    """
    if value is None or not math.isfinite(value) or value <= 0 or value > MAX_SVG_DIMENSION:
        raise VariantRejected(MSG_NOT_AN_IMAGE)
    return max(1, round(value))
