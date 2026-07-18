"""ObjectVariant tests (U1 + U2, object-visuals).

U1 half (model-level): the storage-path contract (per-owner UUID names,
kind-derived extension, no client-filename leakage), the catalog-only
`object_type` restriction, and `original_name`'s display-only independence
from the stored path.

U2 half (API + pipeline): the full reject/accept matrix — happy
PNG/JPEG/SVG uploads, size caps, format sniffing, polyglot re-encoding,
the SVG active-content scan (OURS, not svg-hush's — hush cannot reject),
the DOCTYPE/ENTITY pre-reject, viewBox normalization, EXIF transposition,
per-user quota (count + bytes, atomic under concurrency; R19), the upload
throttle, and soft-delete semantics (R11/R18).

U3 half (file serving): the authenticated `file` action — correct bytes and
Content-Type per sniffed kind, the hardened header contract (private/
immutable caching, BARE attachment disposition, nosniff, CSP on SVG),
soft-deleted variants still serving (AE1's serving half — the R11
keep-rendering mechanism), uniform 404 for foreign/nonexistent ids, and
anonymous rejection.
"""

import shutil
import tempfile
import threading
import xml.etree.ElementTree as ET
from io import BytesIO

from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connections
from django.test import (
    Client,
    SimpleTestCase,
    TestCase,
    TransactionTestCase,
    override_settings,
)
from django.urls import reverse
from PIL import Image
from py_svg_hush import filter_svg

from accounts.models import User
from fm_generator import variants
from fm_generator.models import ObjectVariant, Objects, variant_upload_to

VALID_PASSWORD = 'Correct-Horse-9427!'

# Anything storage-touching runs against a throwaway MEDIA_ROOT so tests
# never write into the real (compose-mounted) media volume. Shared by every
# class in this module; removed once, after all of them (tearDownModule).
TEST_MEDIA_ROOT = tempfile.mkdtemp(prefix='floorcraft-test-media-')


def tearDownModule():
    shutil.rmtree(TEST_MEDIA_ROOT, ignore_errors=True)

CATALOG_TYPES = [value for value, _label in ObjectVariant.CATALOG_TYPE_CHOICES]
NON_CATALOG_OBJECT_TYPES = [
    value for value, _label in Objects.ObjectType.choices
    if value not in CATALOG_TYPES
]

# uploads/user_<owner_id>/<uuid4hex>.<kind>
UPLOAD_PATH_RE = r'^uploads/user_{owner_id}/[0-9a-f]{{32}}\.{ext}$'


def make_verified_user(email='verified@example.com', password=VALID_PASSWORD):
    user = User.objects.create_user(email=email, password=password)
    user.is_active = True
    user.save()
    return user


def variant_kwargs(owner, **overrides):
    """A minimal valid ObjectVariant creation payload."""
    kwargs = {
        'owner': owner,
        'object_type': Objects.ObjectType.CHAIRS,
        'file': SimpleUploadedFile('fancy chair.png', b'png-bytes'),
        'kind': ObjectVariant.Kind.PNG,
        'width': 64,
        'height': 48,
        'size_bytes': 9,
        'original_name': 'fancy chair.png',
    }
    kwargs.update(overrides)
    return kwargs


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class VariantUploadPathTests(TestCase):
    """The variant_upload_to contract: per-owner directory, UUID name,
    extension from the sniffed `kind` — never the client filename, never
    the variant's own pk.
    """

    def setUp(self):
        self.user = make_verified_user()

    def test_upload_to_produces_owner_scoped_uuid_path(self):
        variant = ObjectVariant(owner=self.user, kind=ObjectVariant.Kind.PNG)

        path = variant_upload_to(variant, 'client supplied name.png')

        self.assertRegex(
            path,
            UPLOAD_PATH_RE.format(owner_id=self.user.id, ext='png'),
        )

    def test_upload_to_extension_tracks_kind_not_client_filename(self):
        # The client filename claims .png every time; the extension must
        # follow the row's sniffed kind instead.
        for kind in ObjectVariant.Kind:
            variant = ObjectVariant(owner=self.user, kind=kind)

            path = variant_upload_to(variant, 'claims-to-be.png')

            self.assertTrue(path.endswith(f'.{kind.value}'), (kind, path))

    def test_upload_to_ignores_client_filename_entirely(self):
        variant = ObjectVariant(owner=self.user, kind=ObjectVariant.Kind.SVG)

        path = variant_upload_to(variant, '../../../etc/passwd \x00 <img>.svg')

        self.assertRegex(
            path,
            UPLOAD_PATH_RE.format(owner_id=self.user.id, ext='svg'),
        )
        self.assertNotIn('..', path)
        self.assertNotIn('passwd', path)

    def test_upload_to_keys_off_owner_id_not_variant_pk(self):
        # upload_to runs before the row is saved — the variant's own pk
        # must play no part in the path (it does not exist yet).
        variant = ObjectVariant(owner=self.user, kind=ObjectVariant.Kind.JPEG)
        self.assertIsNone(variant.pk)

        path = variant_upload_to(variant, 'photo.jpeg')

        self.assertRegex(
            path,
            UPLOAD_PATH_RE.format(owner_id=self.user.id, ext='jpeg'),
        )

    def test_created_variant_stores_uuid_named_file_under_owner_directory(self):
        variant = ObjectVariant.objects.create(**variant_kwargs(self.user))

        variant.refresh_from_db()
        self.assertRegex(
            variant.file.name,
            UPLOAD_PATH_RE.format(owner_id=self.user.id, ext='png'),
        )
        # The bytes actually landed under the temp MEDIA_ROOT.
        with variant.file.open('rb') as stored:
            self.assertEqual(stored.read(), b'png-bytes')

    def test_two_uploads_never_share_a_path(self):
        first = ObjectVariant.objects.create(**variant_kwargs(self.user))
        second = ObjectVariant.objects.create(**variant_kwargs(self.user))

        self.assertNotEqual(first.file.name, second.file.name)

    def test_owners_get_distinct_directories(self):
        other = make_verified_user(email='other@example.com')

        mine = ObjectVariant.objects.create(**variant_kwargs(self.user))
        theirs = ObjectVariant.objects.create(**variant_kwargs(other))

        self.assertIn(f'user_{self.user.id}/', mine.file.name)
        self.assertIn(f'user_{other.id}/', theirs.file.name)


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class VariantOriginalNameTests(TestCase):
    """`original_name` is display-only: preserved verbatim on the row and
    entirely absent from the storage path.
    """

    def setUp(self):
        self.user = make_verified_user()

    def test_original_name_stored_independently_of_file_path(self):
        variant = ObjectVariant.objects.create(**variant_kwargs(self.user))

        variant.refresh_from_db()
        self.assertEqual(variant.original_name, 'fancy chair.png')
        self.assertNotIn('fancy', variant.file.name)
        self.assertNotIn('chair', variant.file.name)


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class VariantObjectTypeTests(TestCase):
    """`object_type` accepts exactly the 7 catalog types — shape/line/text
    values from the wider Objects taxonomy (and garbage) are rejected.
    """

    def setUp(self):
        self.user = make_verified_user()

    def build_variant(self, object_type):
        return ObjectVariant(**variant_kwargs(self.user, object_type=object_type))

    def test_all_seven_catalog_types_validate(self):
        self.assertEqual(len(CATALOG_TYPES), 7)

        for object_type in CATALOG_TYPES:
            variant = self.build_variant(object_type)
            variant.full_clean()  # must not raise

    def test_non_catalog_taxonomy_values_are_rejected(self):
        # Every Objects.ObjectType member OUTSIDE the catalog seven
        # (shapes, lines, text) is an invalid variant type.
        self.assertEqual(len(NON_CATALOG_OBJECT_TYPES), 7)

        for object_type in NON_CATALOG_OBJECT_TYPES:
            variant = self.build_variant(object_type)
            with self.assertRaises(ValidationError, msg=object_type) as ctx:
                variant.full_clean()
            self.assertIn('object_type', ctx.exception.message_dict)

    def test_garbage_object_type_is_rejected(self):
        variant = self.build_variant('desk')

        with self.assertRaises(ValidationError) as ctx:
            variant.full_clean()
        self.assertIn('object_type', ctx.exception.message_dict)


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class VariantDefaultsTests(TestCase):
    """Row-level defaults: variants are born active (soft delete is the
    R11 mechanism and only ever flips this flag), with a creation stamp.
    """

    def setUp(self):
        self.user = make_verified_user()

    def test_new_variant_is_active_with_created_at(self):
        variant = ObjectVariant.objects.create(**variant_kwargs(self.user))

        variant.refresh_from_db()
        self.assertTrue(variant.is_active)
        self.assertIsNotNone(variant.created_at)

    def test_owner_relation_exposes_object_variants(self):
        variant = ObjectVariant.objects.create(**variant_kwargs(self.user))

        self.assertIn(variant, self.user.object_variants.all())


# ===========================================================================
# U2: API + pipeline tests
# ===========================================================================

VARIANTS_URL = '/api/object-variants/'

SVG_NS = 'http://www.w3.org/2000/svg'

# --- SVG fixtures ----------------------------------------------------------

SVG_HAPPY = (
    b'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60">'
    b'<rect width="120" height="60" fill="#cc0000"/></svg>'
)
SVG_VIEWBOX_ONLY = (
    b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 150">'
    b'<circle cx="150" cy="75" r="70" fill="#00cc00"/></svg>'
)
# Internal fragment references are the LEGITIMATE use of href/url() and
# must keep working (the scan only rejects non-# targets).
SVG_INTERNAL_REFS = (
    b'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">'
    b'<defs><linearGradient id="g"/></defs>'
    b'<rect width="20" height="20" fill="url(#g)"/></svg>'
)
SVG_SCRIPT = (
    b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
    b'<script>alert(1)</script></svg>'
)
# Same script, hiding in the XHTML namespace — the scan matches localnames.
SVG_NAMESPACED_SCRIPT = (
    b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
    b'<script xmlns="http://www.w3.org/1999/xhtml">alert(1)</script></svg>'
)
SVG_ONLOAD = (
    b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" '
    b'onload="alert(1)"><rect width="5" height="5"/></svg>'
)
SVG_FOREIGN_OBJECT = (
    b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
    b'<foreignObject width="5" height="5"/></svg>'
)
SVG_EXTERNAL_HREF = (
    b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
    b'<image href="https://evil.example/x.png"/></svg>'
)
SVG_EXTERNAL_XLINK_HREF = (
    b'<svg xmlns="http://www.w3.org/2000/svg" '
    b'xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10">'
    b'<image xlink:href="https://evil.example/x.png"/></svg>'
)
SVG_EXTERNAL_STYLE_URL = (
    b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
    b'<rect width="5" height="5" style="fill:url(https://evil.example/f.svg#g)"/></svg>'
)
SVG_EXTERNAL_FILL_URL = (
    b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
    b"<rect width=\"5\" height=\"5\" fill=\"url('https://evil.example/p.png')\"/></svg>"
)
# The benign W3C boilerplate every old-school editor emits: harmless, but
# indistinguishable from a bomb without parsing — dedicated message (R9).
SVG_W3C_DOCTYPE = (
    b'<?xml version="1.0" standalone="no"?>\n'
    b'<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" '
    b'"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n'
    b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'
)
# Billion laughs: ~10 chars of entity declarations expanding to ~3 GB if
# any parser ever expands them. The pre-reject must fire on the raw bytes,
# BEFORE a parse could detonate this.
SVG_ENTITY_BOMB = (
    b'<?xml version="1.0"?>\n'
    b'<!DOCTYPE lolz [\n'
    b' <!ENTITY lol "lolololololololololol">\n'
    b' <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">\n'
    b' <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">\n'
    b' <!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">\n'
    b' <!ENTITY lol5 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;">\n'
    b' <!ENTITY lol6 "&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;">\n'
    b' <!ENTITY lol7 "&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;">\n'
    b' <!ENTITY lol8 "&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;">\n'
    b' <!ENTITY lol9 "&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;">\n'
    b']>\n'
    b'<svg xmlns="http://www.w3.org/2000/svg">&lol9;</svg>'
)
# Quadratic blowup: one large entity referenced many times — no nesting, so
# it dodges naive nesting-depth defenses; the pre-reject catches the ENTITY
# declaration itself.
SVG_QUADRATIC_BLOWUP = (
    b'<?xml version="1.0"?>\n'
    b'<!DOCTYPE bomb [<!ENTITY a "' + b'x' * 2000 + b'">]>\n'
    b'<svg xmlns="http://www.w3.org/2000/svg">' + b'&a;' * 2000 + b'</svg>'
)
SVG_NO_NAMESPACE = b'<svg width="10" height="10"/>'
# A UTF-16 entity bomb: scans clean as UTF-8 substrings never match, but
# the NUL-byte guard rejects it before any parser could honor the utf-16
# declaration and "discover" the DOCTYPE (the encoding-smuggle vector).
SVG_UTF16_BOMB = (
    '<?xml version="1.0" encoding="utf-16"?>'
    '<!DOCTYPE svg [<!ENTITY a "b">]>'
    '<svg xmlns="http://www.w3.org/2000/svg">&a;</svg>'
).encode('utf-16-le')


# --- raster fixture builders ----------------------------------------------

def png_bytes(width=4, height=4, color=(200, 30, 30)):
    buffer = BytesIO()
    Image.new('RGB', (width, height), color).save(buffer, format='PNG')
    return buffer.getvalue()


def jpeg_bytes(width=4, height=4, color=(30, 200, 30), exif_orientation=None):
    buffer = BytesIO()
    image = Image.new('RGB', (width, height), color)
    save_kwargs = {'format': 'JPEG'}
    if exif_orientation is not None:
        exif = Image.Exif()
        exif[0x0112] = exif_orientation  # the EXIF Orientation tag
        save_kwargs['exif'] = exif
    image.save(buffer, **save_kwargs)
    return buffer.getvalue()


def mpo_bytes(width=6, height=4):
    """A real MPO (multi-picture JPEG container, common phone output):
    starts with JPEG magic, Pillow reports format 'MPO'."""
    buffer = BytesIO()
    first = Image.new('RGB', (width, height), (200, 30, 30))
    second = Image.new('RGB', (width, height), (30, 30, 200))
    first.save(buffer, format='MPO', append_images=[second])
    return buffer.getvalue()


def apng_bytes(width=8, height=8):
    """An animated PNG; the pipeline's contract keeps frame one only."""
    buffer = BytesIO()
    frames = [
        Image.new('RGB', (width, height), (200, 30, 30)),
        Image.new('RGB', (width, height), (30, 30, 200)),
    ]
    frames[0].save(buffer, format='PNG', save_all=True, append_images=frames[1:])
    return buffer.getvalue()


# --- API helpers -----------------------------------------------------------

def login(client, email='verified@example.com', password=VALID_PASSWORD):
    client.post(
        reverse('login'),
        {'email': email, 'password': password},
        content_type='application/json',
    )


def post_variant(client, name, content, object_type='chairs'):
    return client.post(VARIANTS_URL, {
        'object_type': object_type,
        'file': SimpleUploadedFile(name, content),
    })


def stored_bytes(variant):
    with variant.file.open('rb') as handle:
        return handle.read()


def seed_variants(owner, count, *, size_bytes=1, is_active=True, start=0):
    """Quota fixtures via the ORM (bypassing the API keeps these out of the
    upload throttle's ledger and off the disk — FileField happily stores a
    path string that never had bytes behind it)."""
    ObjectVariant.objects.bulk_create([
        ObjectVariant(
            owner=owner,
            object_type=Objects.ObjectType.CHAIRS,
            file=f'uploads/user_{owner.id}/seed{start + index}.png',
            kind=ObjectVariant.Kind.PNG,
            width=1,
            height=1,
            size_bytes=size_bytes,
            original_name=f'seed{start + index}.png',
            is_active=is_active,
        )
        for index in range(count)
    ])


class VariantApiTestCase(TestCase):
    """Shared setup for the authenticated-API test classes: a verified,
    logged-in owner and a clean throttle ledger (the default LocMemCache
    persists across tests in one process)."""

    def setUp(self):
        cache.clear()
        self.user = make_verified_user()
        login(self.client)

    def assert_rejected(self, name, content, fragment, *, message=None):
        """Upload must 400 with the given message fragment on `file`, and
        leave no row behind."""
        before = ObjectVariant.objects.count()
        response = post_variant(self.client, name, content)
        self.assertEqual(response.status_code, 400, response.content)
        detail = response.json()['file'][0]
        self.assertIn(fragment, detail)
        if message is not None:
            self.assertEqual(detail, message)
        self.assertEqual(ObjectVariant.objects.count(), before)
        return detail


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class VariantUploadHappyPathTests(VariantApiTestCase):
    """AE2's server half: valid PNG/JPEG/SVG uploads create rows with the
    SNIFFED kind, recorded natural dimensions, and size_bytes matching what
    actually landed on disk (post-pipeline, not the upload's own size)."""

    def test_png_upload_creates_row_with_sniffed_kind_and_dimensions(self):
        response = post_variant(self.client, 'my chair.png', png_bytes(40, 20))

        self.assertEqual(response.status_code, 201, response.content)
        variant = ObjectVariant.objects.get()
        self.assertEqual(variant.owner, self.user)
        self.assertEqual(variant.kind, ObjectVariant.Kind.PNG)
        self.assertEqual((variant.width, variant.height), (40, 20))
        self.assertEqual(variant.original_name, 'my chair.png')
        self.assertTrue(variant.is_active)
        # size_bytes is the POST-pipeline truth: exactly the stored file.
        self.assertEqual(variant.size_bytes, variant.file.size)

        payload = response.json()
        self.assertEqual(payload['id'], variant.id)
        self.assertEqual(payload['object_type'], 'chairs')
        self.assertEqual((payload['width'], payload['height']), (40, 20))
        self.assertEqual(payload['original_name'], 'my chair.png')
        self.assertIn('created_at', payload)
        # file is write-only; consumers get the U3 URL convention instead.
        self.assertNotIn('file', payload)
        self.assertEqual(payload['file_url'], f'/api/object-variants/{variant.id}/file/')

    def test_jpeg_upload_sniffed_as_jpeg(self):
        response = post_variant(self.client, 'photo.jpg', jpeg_bytes(10, 8))

        self.assertEqual(response.status_code, 201, response.content)
        variant = ObjectVariant.objects.get()
        self.assertEqual(variant.kind, ObjectVariant.Kind.JPEG)
        self.assertEqual((variant.width, variant.height), (10, 8))
        self.assertEqual(variant.size_bytes, variant.file.size)

    def test_mpo_phone_jpeg_accepted_as_jpeg(self):
        # Pillow reports phone-camera multi-picture files as MPO; the
        # pipeline treats them as JPEG and collapses to a single frame.
        response = post_variant(self.client, 'phone shot.jpg', mpo_bytes())

        self.assertEqual(response.status_code, 201, response.content)
        variant = ObjectVariant.objects.get()
        self.assertEqual(variant.kind, ObjectVariant.Kind.JPEG)
        stored = Image.open(BytesIO(stored_bytes(variant)))
        self.assertEqual(stored.format, 'JPEG')  # plain JPEG now, not MPO

    def test_sideways_exif_jpeg_comes_out_upright(self):
        # Orientation 6 = "rotate 90 CW to display": a 40x20 buffer that
        # SHOWS as 20x40. Transpose-first means the stored pixels are
        # upright and the recorded dims match them.
        response = post_variant(
            self.client, 'sideways.jpg', jpeg_bytes(40, 20, exif_orientation=6)
        )

        self.assertEqual(response.status_code, 201, response.content)
        variant = ObjectVariant.objects.get()
        self.assertEqual((variant.width, variant.height), (20, 40))
        stored = Image.open(BytesIO(stored_bytes(variant)))
        self.assertEqual(stored.size, (20, 40))
        # The orientation tag (and all other EXIF) died in the re-encode —
        # nothing left to double-rotate in a browser.
        self.assertIsNone(stored.getexif().get(0x0112))

    def test_polyglot_raster_survives_only_as_clean_reencoded_bytes(self):
        # A classic polyglot: valid PNG with an HTML/script payload after
        # IEND. The stored bytes must be a fresh encode — never the
        # original buffer — so the payload cannot survive.
        uploaded = png_bytes(6, 6) + b'<script>alert(1)</script><html></html>'
        response = post_variant(self.client, 'sneaky.png', uploaded)

        self.assertEqual(response.status_code, 201, response.content)
        variant = ObjectVariant.objects.get()
        stored = stored_bytes(variant)
        self.assertNotEqual(stored, uploaded)
        self.assertNotIn(b'<script>', stored)
        self.assertEqual(Image.open(BytesIO(stored)).format, 'PNG')
        self.assertEqual(variant.size_bytes, len(stored))

    def test_animated_png_keeps_frame_one_only(self):
        response = post_variant(self.client, 'spinner.png', apng_bytes())

        self.assertEqual(response.status_code, 201, response.content)
        stored = Image.open(BytesIO(stored_bytes(ObjectVariant.objects.get())))
        self.assertFalse(getattr(stored, 'is_animated', False))

    def test_svg_upload_stores_svg_hush_output(self):
        response = post_variant(self.client, 'plan.svg', SVG_HAPPY)

        self.assertEqual(response.status_code, 201, response.content)
        variant = ObjectVariant.objects.get()
        self.assertEqual(variant.kind, ObjectVariant.Kind.SVG)
        self.assertEqual((variant.width, variant.height), (120, 60))
        # Defense-in-depth contract: what lands on disk is svg-hush's
        # filtered output (the root already had absolute dims, so no
        # normalization rewrite on top).
        self.assertEqual(stored_bytes(variant), filter_svg(SVG_HAPPY))
        self.assertEqual(variant.size_bytes, variant.file.size)

    def test_viewbox_only_svg_gets_absolute_dimensions(self):
        # The Firefox blank-render fix: a viewBox-only root gains absolute
        # width/height derived from the viewBox, recorded on the row.
        response = post_variant(self.client, 'icon.svg', SVG_VIEWBOX_ONLY)

        self.assertEqual(response.status_code, 201, response.content)
        variant = ObjectVariant.objects.get()
        self.assertEqual((variant.width, variant.height), (300, 150))
        root = ET.fromstring(stored_bytes(variant))
        self.assertEqual(root.get('width'), '300')
        self.assertEqual(root.get('height'), '150')

    def test_svg_with_internal_fragment_references_is_accepted(self):
        # url(#gradient) is the legitimate pattern the external-reference
        # rules must NOT catch.
        response = post_variant(self.client, 'gradient.svg', SVG_INTERNAL_REFS)

        self.assertEqual(response.status_code, 201, response.content)


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class VariantUploadRejectionTests(VariantApiTestCase):
    """The reject half of the matrix (R9: every rejection is specific and
    friendly). Includes AE2's error paths and the plan's bomb samples."""

    def test_disallowed_extension_rejected(self):
        self.assert_rejected('notes.txt', b'hello', 'Unsupported file type')

    def test_extensionless_name_rejected(self):
        self.assert_rejected('README', b'hello', 'Unsupported file type')

    def test_oversize_raster_gets_size_message(self):
        blob = b'x' * (variants.MAX_RASTER_BYTES + 1)
        self.assert_rejected('big.png', blob, '5 MB', message=variants.MSG_RASTER_TOO_BIG)

    def test_oversize_svg_gets_size_message(self):
        blob = b'<svg>' + b' ' * variants.MAX_SVG_BYTES
        self.assert_rejected('big.svg', blob, '1 MB', message=variants.MSG_SVG_TOO_BIG)

    def test_disguised_html_named_png_gets_format_message(self):
        # Wrong on both axes: claims PNG, isn't a raster, isn't SVG either.
        self.assert_rejected(
            'page.png',
            b'<html><body><h1>not an image</h1></body></html>',
            'SVG, PNG, or JPEG',
            message=variants.MSG_NOT_AN_IMAGE,
        )

    def test_truncated_png_rejected(self):
        # Valid magic bytes, broken body — Pillow's verify/decode fails.
        self.assert_rejected(
            'broken.png', png_bytes(20, 20)[:24], 'SVG, PNG, or JPEG',
            message=variants.MSG_NOT_AN_IMAGE,
        )

    def test_svg_active_content_rejected_by_our_scan(self):
        """Every active-content fixture: rejected with OUR message. The
        svg-hush cross-check below (filter_svg succeeding on the same
        bytes) proves hush was not — and could never be — the rejection
        path: it strips silently instead of rejecting (the plan's verified
        finding), so a rejection message can only have come from our scan.
        """
        cases = {
            'script element': SVG_SCRIPT,
            'namespaced script element': SVG_NAMESPACED_SCRIPT,
            'onload attribute': SVG_ONLOAD,
            'foreignObject element': SVG_FOREIGN_OBJECT,
            'external href': SVG_EXTERNAL_HREF,
            'external xlink:href': SVG_EXTERNAL_XLINK_HREF,
            'external url() in style': SVG_EXTERNAL_STYLE_URL,
            'external url() in fill': SVG_EXTERNAL_FILL_URL,
        }
        for label, fixture in cases.items():
            with self.subTest(label):
                self.assert_rejected('active.svg', fixture, 'active content')
                # svg-hush happily filters the same input without raising —
                # the 400 above cannot have been its doing.
                self.assertIsInstance(filter_svg(fixture), bytes)

    def test_benign_w3c_doctype_gets_dedicated_doctype_message(self):
        detail = self.assert_rejected(
            'legacy.svg', SVG_W3C_DOCTYPE,
            'remove the DOCTYPE declaration and re-export',
            message=variants.MSG_DOCTYPE,
        )
        # Specifically NOT the generic format error (R9's "explains why").
        self.assertNotEqual(detail, variants.MSG_NOT_AN_IMAGE)

    def test_entity_bomb_rejected_by_pre_reject(self):
        # If this test hangs or OOMs, the pre-reject regressed and the
        # billion-laughs payload reached a parser.
        self.assert_rejected(
            'bomb.svg', SVG_ENTITY_BOMB, 'DOCTYPE', message=variants.MSG_DOCTYPE,
        )

    def test_quadratic_blowup_rejected_by_pre_reject(self):
        self.assert_rejected(
            'blowup.svg', SVG_QUADRATIC_BLOWUP, 'DOCTYPE', message=variants.MSG_DOCTYPE,
        )

    def test_utf16_smuggled_bomb_rejected_without_parsing(self):
        # UTF-16 bytes dodge ASCII substring scans; the NUL guard rejects
        # them as not-an-image before any parser can honor the declaration.
        self.assert_rejected(
            'smuggle.svg', SVG_UTF16_BOMB, 'SVG, PNG, or JPEG',
            message=variants.MSG_NOT_AN_IMAGE,
        )

    def test_degenerate_viewbox_values_rejected(self):
        # viewBox numbers flow into the frontend's aspect-fit math — zero,
        # negative, non-finite, and enormous values are format rejections.
        template = (
            b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="%s">'
            b'<rect width="1" height="1"/></svg>'
        )
        for view_box in (b'0 0 0 150', b'0 0 -10 150', b'0 0 1e300 150',
                         b'0 0 NaN 150', b'0 0 30000 150'):
            with self.subTest(view_box.decode()):
                self.assert_rejected(
                    'degenerate.svg', template % view_box, 'SVG, PNG, or JPEG',
                    message=variants.MSG_NOT_AN_IMAGE,
                )

    def test_svg_without_namespace_rejected(self):
        # A bare un-namespaced <svg> does not render in any XML context
        # (and svg-hush hard-errors on it); rejected with our message.
        self.assert_rejected(
            'bare.svg', SVG_NO_NAMESPACE, 'SVG, PNG, or JPEG',
            message=variants.MSG_NOT_AN_IMAGE,
        )


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class VariantOriginalNameApiTests(VariantApiTestCase):
    """R12: `original_name` derives from the upload's filename, stored
    control-character-stripped (it round-trips into tooltips/aria)."""

    def test_control_characters_stripped_from_original_name(self):
        response = post_variant(self.client, 'chair\x07\x1fname.png', png_bytes())

        self.assertEqual(response.status_code, 201, response.content)
        variant = ObjectVariant.objects.get()
        self.assertEqual(variant.original_name, 'chairname.png')
        self.assertEqual(response.json()['original_name'], 'chairname.png')


class VariantPipelineUnitTests(SimpleTestCase):
    """Pure-function coverage of variants.py (no DB, no HTTP) — the module
    is deliberately importable so the security matrix can be pinned at this
    level too."""

    def test_svg_hush_strips_silently_and_cannot_reject(self):
        """The plan's empirical finding, kept pinned as a test: filter_svg
        never raises on active content — it silently strips — so R9's
        friendly rejection can only come from our scan. If a py-svg-hush
        upgrade ever changes this, this test flags the assumption."""
        hushed = filter_svg(SVG_SCRIPT)
        self.assertIsInstance(hushed, bytes)
        self.assertNotIn(b'alert(1)', hushed)  # stripped, not preserved...
        with self.assertRaises(variants.VariantRejected) as ctx:
            variants.process_upload(SVG_SCRIPT)  # ...while WE reject.
        self.assertIn('active content', str(ctx.exception))

    def test_process_upload_sniffs_content_not_names(self):
        processed = variants.process_upload(png_bytes(5, 3))
        self.assertEqual(processed.kind, 'png')
        self.assertEqual((processed.width, processed.height), (5, 3))

        processed = variants.process_upload(jpeg_bytes(7, 2))
        self.assertEqual(processed.kind, 'jpeg')

        processed = variants.process_upload(SVG_HAPPY)
        self.assertEqual(processed.kind, 'svg')

    def test_check_extension_allowlist(self):
        for name in ('a.svg', 'b.png', 'c.jpg', 'd.jpeg', 'SHOUTY.PNG'):
            with self.subTest(name):
                self.assertIn(variants.check_extension(name), variants.ALLOWED_EXTENSIONS)
        for name in ('e.gif', 'f.webp', 'g.txt', 'noext', '', None):
            with self.subTest(repr(name)):
                with self.assertRaises(variants.VariantRejected):
                    variants.check_extension(name)

    def test_check_byte_cap_per_format(self):
        variants.check_byte_cap('svg', variants.MAX_SVG_BYTES)  # at cap: fine
        variants.check_byte_cap('png', variants.MAX_RASTER_BYTES)
        with self.assertRaises(variants.VariantRejected) as ctx:
            variants.check_byte_cap('svg', variants.MAX_SVG_BYTES + 1)
        self.assertEqual(str(ctx.exception), variants.MSG_SVG_TOO_BIG)
        with self.assertRaises(variants.VariantRejected) as ctx:
            variants.check_byte_cap('jpeg', variants.MAX_RASTER_BYTES + 1)
        self.assertEqual(str(ctx.exception), variants.MSG_RASTER_TOO_BIG)

    def test_clean_original_name_strips_control_characters(self):
        self.assertEqual(
            variants.clean_original_name('a\x00b\nc\x1bd.png', fallback='u.png'),
            'abcd.png',
        )

    def test_clean_original_name_caps_at_255(self):
        cleaned = variants.clean_original_name('x' * 300 + '.png', fallback='u.png')
        self.assertEqual(len(cleaned), 255)

    def test_clean_original_name_falls_back_when_nothing_survives(self):
        self.assertEqual(
            variants.clean_original_name('\x00\x01\x02', fallback='upload.png'),
            'upload.png',
        )
        self.assertEqual(variants.clean_original_name('', fallback='upload.svg'), 'upload.svg')

    def test_variant_file_url_convention(self):
        # U3's serving route, by convention (see variant_file_url).
        self.assertEqual(variants.variant_file_url(7), '/api/object-variants/7/file/')

    def test_throttle_is_self_contained(self):
        # Hardcoded scope/rate — settings.py deliberately untouched by U2.
        throttle = variants.VariantUploadThrottle()
        self.assertEqual(throttle.rate, '20/min')
        self.assertEqual((throttle.num_requests, throttle.duration), (20, 60))


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class VariantListTests(VariantApiTestCase):
    """List = the caller's ACTIVE variants only, stably ordered, carrying
    the file_url convention (R6/R8: personal, cross-plan catalog)."""

    def test_list_returns_only_callers_active_variants(self):
        mine = ObjectVariant.objects.create(**variant_kwargs(self.user))
        ObjectVariant.objects.create(**variant_kwargs(self.user, is_active=False))
        other = make_verified_user(email='other@example.com')
        ObjectVariant.objects.create(**variant_kwargs(other))

        response = self.client.get(VARIANTS_URL)

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual([item['id'] for item in payload], [mine.id])
        self.assertEqual(payload[0]['file_url'], f'/api/object-variants/{mine.id}/file/')

    def test_list_is_stably_ordered_by_creation(self):
        created = [
            ObjectVariant.objects.create(**variant_kwargs(self.user))
            for _ in range(3)
        ]

        response = self.client.get(VARIANTS_URL)

        self.assertEqual(
            [item['id'] for item in response.json()],
            [variant.id for variant in created],
        )


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class VariantDestroyTests(VariantApiTestCase):
    """AE1's server half + R18: destroy is a SOFT delete (row and file
    survive — placed objects keep rendering), idempotent, and uniformly
    404 for anything that is not the caller's own variant."""

    def test_destroy_soft_deletes_row_and_keeps_file(self):
        variant = ObjectVariant.objects.create(**variant_kwargs(self.user))

        response = self.client.delete(f'{VARIANTS_URL}{variant.id}/')

        self.assertEqual(response.status_code, 204)
        variant.refresh_from_db()  # row still exists...
        self.assertFalse(variant.is_active)  # ...just inactive,
        # ...and the bytes still exist on disk (retention stance: the file
        # keeps serving via U3 and keeps counting toward quota).
        self.assertTrue(variant.file.storage.exists(variant.file.name))

    def test_second_destroy_is_idempotent_204(self):
        # The destroy queryset deliberately does NOT filter is_active, so
        # deleting an already-deleted variant succeeds quietly (R18).
        variant = ObjectVariant.objects.create(**variant_kwargs(self.user))
        self.client.delete(f'{VARIANTS_URL}{variant.id}/')

        response = self.client.delete(f'{VARIANTS_URL}{variant.id}/')

        self.assertEqual(response.status_code, 204)

    def test_foreign_and_nonexistent_destroy_both_404(self):
        # Uniform 404 (the R14 anti-oracle pattern): a foreign id and a
        # nonexistent id must be indistinguishable.
        other = make_verified_user(email='other@example.com')
        foreign = ObjectVariant.objects.create(**variant_kwargs(other))

        foreign_response = self.client.delete(f'{VARIANTS_URL}{foreign.id}/')
        missing_response = self.client.delete(f'{VARIANTS_URL}999999/')

        self.assertEqual(foreign_response.status_code, 404)
        self.assertEqual(missing_response.status_code, 404)
        foreign.refresh_from_db()
        self.assertTrue(foreign.is_active)  # untouched

    def test_soft_deleted_variant_absent_from_list(self):
        variant = ObjectVariant.objects.create(**variant_kwargs(self.user))
        self.client.delete(f'{VARIANTS_URL}{variant.id}/')

        response = self.client.get(VARIANTS_URL)

        self.assertEqual(response.json(), [])


class VariantPermissionTests(TestCase):
    """Anonymous requests are rejected on every variant route."""

    def test_anonymous_list_rejected(self):
        self.assertIn(self.client.get(VARIANTS_URL).status_code, (401, 403))

    def test_anonymous_upload_rejected(self):
        response = post_variant(self.client, 'chair.png', png_bytes())
        self.assertIn(response.status_code, (401, 403))
        self.assertEqual(ObjectVariant.objects.count(), 0)

    def test_anonymous_destroy_rejected(self):
        self.assertIn(self.client.delete(f'{VARIANTS_URL}1/').status_code, (401, 403))

    def test_anonymous_file_fetch_rejected(self):
        # U3: the serving action sits behind the same IsAuthenticated wall
        # as every other variant route — rejection happens before any
        # lookup, so no id (real or not) leaks anything to anonymous.
        self.assertIn(self.client.get(f'{VARIANTS_URL}1/file/').status_code, (401, 403))


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class VariantQuotaTests(VariantApiTestCase):
    """R19: per-user count + byte quotas, soft-deleted variants included."""

    def test_upload_at_count_boundary_succeeds(self):
        seed_variants(self.user, variants.MAX_VARIANT_COUNT - 1)

        response = post_variant(self.client, 'chair.png', png_bytes())

        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(
            ObjectVariant.objects.filter(owner=self.user).count(),
            variants.MAX_VARIANT_COUNT,
        )

    def test_101st_upload_hits_count_quota(self):
        # Half the seeds are soft-deleted: they must still count (their
        # files persist — the retention stance).
        seed_variants(self.user, 50, is_active=True)
        seed_variants(self.user, 50, is_active=False, start=50)

        response = post_variant(self.client, 'chair.png', png_bytes())

        self.assertEqual(response.status_code, 400, response.content)
        self.assertEqual(response.json()['file'], [variants.MSG_QUOTA])
        self.assertEqual(
            ObjectVariant.objects.filter(owner=self.user).count(),
            variants.MAX_VARIANT_COUNT,
        )

    def test_byte_quota_exceeded_gets_quota_message(self):
        # One seed almost at the byte cap; any real upload tips it over.
        seed_variants(self.user, 1, size_bytes=variants.MAX_VARIANT_TOTAL_BYTES - 5)

        response = post_variant(self.client, 'chair.png', png_bytes())

        self.assertEqual(response.status_code, 400, response.content)
        self.assertEqual(response.json()['file'], [variants.MSG_QUOTA])

    def test_quota_ignores_other_users(self):
        other = make_verified_user(email='other@example.com')
        seed_variants(other, variants.MAX_VARIANT_COUNT)

        response = post_variant(self.client, 'chair.png', png_bytes())

        self.assertEqual(response.status_code, 201, response.content)


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class VariantUploadThrottleTests(VariantApiTestCase):
    """R19: the upload action is rate-limited (20/min, hardcoded in
    VariantUploadThrottle). Rejected uploads count too — throttling runs
    before validation, so garbage bursts can't dodge the meter."""

    def tearDown(self):
        cache.clear()  # don't leak this class's ledger into later tests

    def test_burst_past_limit_returns_429(self):
        for index in range(20):
            response = post_variant(self.client, 'junk.txt', b'not an image')
            self.assertEqual(response.status_code, 400, f'request {index}')

        response = post_variant(self.client, 'junk.txt', b'not an image')

        self.assertEqual(response.status_code, 429)

    def test_throttle_scopes_to_create_only(self):
        # Exhaust the upload budget, then confirm list is untouched.
        for _ in range(21):
            post_variant(self.client, 'junk.txt', b'not an image')

        self.assertEqual(self.client.get(VARIANTS_URL).status_code, 200)


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class VariantQuotaConcurrencyTests(TransactionTestCase):
    """The R19 TOCTOU fix, proven under real concurrency: two uploads
    racing at the count boundary must serialize on the row locks
    (select_for_update in perform_create) so at most ONE commits.

    TransactionTestCase (not TestCase) because the two worker threads need
    their own real, committing connections — TestCase's wrapping
    transaction would make each thread's view of the data undefined.
    Postgres backs the test database, so FOR UPDATE semantics are the real
    thing.

    The assertion is deterministic regardless of interleaving: if the
    threads overlap, the loser blocks on the winner's locks and its
    fresh-snapshot aggregate (statement 2) sees the winner's committed row;
    if they don't overlap, the loser simply reads the full count. Either
    way exactly one 201 and one quota 400.
    """

    def test_concurrent_uploads_cannot_commit_past_the_count_cap(self):
        cache.clear()
        user = make_verified_user(email='racer@example.com')
        seed_variants(user, variants.MAX_VARIANT_COUNT - 1)

        barrier = threading.Barrier(2, timeout=15)
        results = []
        results_lock = threading.Lock()
        payload = png_bytes()

        def worker():
            try:
                client = Client()
                login(client, email='racer@example.com')
                barrier.wait()  # maximize the overlap window
                response = post_variant(client, 'racing.png', payload)
                with results_lock:
                    results.append((response.status_code, response.json()))
            except Exception as exc:  # surfaced via the assertion below
                with results_lock:
                    results.append(('error', repr(exc)))
            finally:
                # Each thread got its own thread-local connections; close
                # them or the test DB teardown hangs on lingering sessions.
                connections.close_all()

        threads = [threading.Thread(target=worker) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)

        statuses = sorted(status for status, _ in results)
        self.assertEqual(statuses, [201, 400], results)
        rejected_body = next(body for status, body in results if status == 400)
        self.assertEqual(rejected_body['file'], [variants.MSG_QUOTA])
        # The cap held: exactly MAX rows, never MAX + 1.
        self.assertEqual(
            ObjectVariant.objects.filter(owner=user).count(),
            variants.MAX_VARIANT_COUNT,
        )


# ===========================================================================
# U3: authenticated file serving
# ===========================================================================

FILE_CACHE_CONTROL = 'private, max-age=31536000, immutable'
SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'"


def file_url(variant_id):
    return f'{VARIANTS_URL}{variant_id}/file/'


def fetch_file(client, variant_id):
    return client.get(file_url(variant_id))


def streamed(response):
    """FileResponse bodies are streaming — drain them for byte assertions."""
    return b''.join(response.streaming_content)


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class VariantFileServingTests(VariantApiTestCase):
    """The U3 serving contract: exact stored bytes, kind-derived
    Content-Type, and the hardened headers on EVERY response — private/
    immutable caching (UUID filenames make immutable safe; repeat catalog/
    canvas use and export must hit the browser cache), BARE attachment
    disposition (never a filename parameter — original_name in a response
    header would be an injection surface), and nosniff."""

    def tearDown(self):
        cache.clear()  # the throttle-exhaustion test writes a ledger

    def assert_hardened_headers(self, response):
        self.assertEqual(response['Cache-Control'], FILE_CACHE_CONTROL)
        # BARE attachment: assertEqual (not assertIn) proves no filename
        # parameter — original_name must never ride a response header.
        self.assertEqual(response['Content-Disposition'], 'attachment')
        self.assertEqual(response['X-Content-Type-Options'], 'nosniff')

    def upload_and_get(self, name, content):
        response = post_variant(self.client, name, content)
        self.assertEqual(response.status_code, 201, response.content)
        variant = ObjectVariant.objects.get()
        return variant, fetch_file(self.client, variant.id)

    def test_owner_fetches_png_with_exact_bytes_and_hardened_headers(self):
        variant, response = self.upload_and_get('chair.png', png_bytes(40, 20))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Content-Type'], 'image/png')
        # The exact post-pipeline bytes that live on disk — not the upload.
        self.assertEqual(streamed(response), stored_bytes(variant))
        self.assert_hardened_headers(response)
        # The CSP is SVG-only hardening; rasters must not carry it.
        self.assertNotIn('Content-Security-Policy', response)

    def test_jpeg_served_with_jpeg_content_type_and_caching_headers(self):
        variant, response = self.upload_and_get('photo.jpg', jpeg_bytes(10, 8))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Content-Type'], 'image/jpeg')
        self.assertEqual(streamed(response), stored_bytes(variant))
        self.assert_hardened_headers(response)
        self.assertNotIn('Content-Security-Policy', response)

    def test_svg_served_with_svg_content_type_and_restrictive_csp(self):
        # Direct-navigation hardening: were the SVG ever viewed as a
        # document, nothing executes or fetches. <img>/Konva subresource
        # rendering ignores the document CSP (and the attachment
        # disposition), so the canvas is unaffected.
        variant, response = self.upload_and_get('plan.svg', SVG_HAPPY)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Content-Type'], 'image/svg+xml')
        self.assertEqual(streamed(response), stored_bytes(variant))
        self.assert_hardened_headers(response)
        self.assertEqual(response['Content-Security-Policy'], SVG_CSP)

    def test_soft_deleted_variant_still_serves_its_file(self):
        # AE1's serving half — soft delete is the R11 keep-rendering
        # mechanism: the catalog forgets the variant, but placed objects
        # and undo snapshots reference it forever, so the file action's
        # queryset deliberately skips the is_active filter.
        variant, first = self.upload_and_get('keeper.png', png_bytes(6, 6))
        expected = streamed(first)
        self.assertEqual(
            self.client.delete(f'{VARIANTS_URL}{variant.id}/').status_code, 204,
        )
        variant.refresh_from_db()
        self.assertFalse(variant.is_active)  # really soft-deleted...

        response = fetch_file(self.client, variant.id)

        self.assertEqual(response.status_code, 200)  # ...and still serving
        self.assertEqual(streamed(response), expected)
        self.assert_hardened_headers(response)

    def test_foreign_and_nonexistent_ids_get_identical_404s(self):
        # Uniform 404 (the R14 anti-oracle pattern): same status AND same
        # body, so the endpoint cannot be used as an existence oracle over
        # other users' variant ids.
        other = make_verified_user(email='other@example.com')
        foreign = ObjectVariant.objects.create(**variant_kwargs(other))

        foreign_response = fetch_file(self.client, foreign.id)
        missing_response = fetch_file(self.client, 999999)

        self.assertEqual(foreign_response.status_code, 404)
        self.assertEqual(missing_response.status_code, 404)
        self.assertEqual(foreign_response.json(), missing_response.json())

    def test_file_serving_survives_an_exhausted_upload_throttle(self):
        # The throttle stays create-only (R19 guards the expensive action):
        # a user who has burned their upload budget must still be able to
        # RENDER — the canvas fetches many files at once.
        variant, first = self.upload_and_get('chair.png', png_bytes())
        self.assertEqual(first.status_code, 200)
        for _ in range(21):  # exhaust the 20/min create budget past 429
            post_variant(self.client, 'junk.txt', b'not an image')

        response = fetch_file(self.client, variant.id)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(streamed(response), stored_bytes(variant))
