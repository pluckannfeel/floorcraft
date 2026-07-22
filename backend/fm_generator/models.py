import uuid

from django.conf import settings
from django.core.validators import MinValueValidator
from django.db import models


class FloorPlan(models.Model):
    class Unit(models.TextChoices):
        # The two display units the canvas-rulers-scale feature supports
        # (R2/R9): plain metric meters and architectural feet-and-inches
        # (e.g. `11' 6"`). This is a DISPLAY/formatting choice ONLY. The
        # stored scale (`real_size_per_grid_square`) is ALWAYS canonical
        # METERS regardless of this field — so switching the unit never
        # rescales the plan, it re-formats the SAME physical measurements
        # into the other notation. This is exactly origin AE2: a square
        # shown as `0.9 m` in metric shows as `3' 0"` in imperial — one
        # physical size, two labels. (v1 UI: the scale/unit control edits
        # the stored-meters scalar directly and DISPLAYS the equivalent in
        # this unit; the rulers convert stored meters to the display unit
        # at format time. Typing a dimension in imperial notation to set
        # the scale is a deferred, panel-era concern.)
        METERS = 'meters', 'Meters'
        FEET_INCHES = 'feet_inches', 'Feet & inches'

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='floor_plans')
    name = models.CharField(max_length=255)
    grid_size = models.PositiveIntegerField(default=20)
    canvas_width = models.PositiveIntegerField(default=1600)
    canvas_height = models.PositiveIntegerField(default=1200)

    # The real-world size, in canonical METERS (always — independent of
    # the `unit` display field; see Unit's doc), that ONE grid square
    # represents — the scale foundation the canvas rulers convert against
    # (canvas-rulers-scale, R1). Model pixels map to real meters via
    # `real_size_per_grid_square / grid_size`, so this scalar plus the grid
    # is the whole scale definition (one scale per plan). The
    # `MinValueValidator(0.0001)`
    # floor makes DRF derive a `min_value` on the serializer field, so a
    # zero or negative scale (which would divide-by-zero / invert the
    # rulers) is rejected at the API boundary rather than persisting.
    # Carrying a default means the `AddField` migration backfills every
    # pre-existing row automatically (R3/AE3): a plan created before this
    # feature opens with a working 1-square = 0.5 ruler, no config needed.
    real_size_per_grid_square = models.FloatField(
        default=0.5,
        validators=[MinValueValidator(0.0001)],
    )

    # The unit the ruler labels and the scale value are DISPLAYED in
    # (canvas-rulers-scale, R2). Defaulting to meters (with the default
    # scale above) means pre-existing rows backfill to a sensible metric
    # ruler via `AddField` (R3/AE3), matching the origin's resolved
    # default of 1 grid square = 0.5 m, metric.
    unit = models.CharField(
        max_length=12,
        choices=Unit.choices,
        default=Unit.METERS,
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.name


class Objects(models.Model):
    class ObjectType(models.TextChoices):
        # Catalog types
        OUTLINES = 'outlines', 'Outlines'
        TABLES = 'tables', 'Tables'
        DOORS = 'doors', 'Doors'
        CHAIRS = 'chairs', 'Chairs'
        FURNITURES = 'furnitures', 'Furnitures'
        APPLIANCES = 'appliances', 'Appliances'
        LIGHTING = 'lighting', 'Lighting'
        # Shape types
        SHAPE_RECTANGLE = 'shape_rectangle', 'Shape: Rectangle'
        SHAPE_SQUARE = 'shape_square', 'Shape: Square'
        SHAPE_CIRCLE = 'shape_circle', 'Shape: Circle'
        # Line types
        LINE_STRAIGHT = 'line_straight', 'Line: Straight'
        LINE_CURVED = 'line_curved', 'Line: Curved'
        LINE_S_CURVE = 'line_s_curve', 'Line: S-Curve'
        # Text type (U7, canvas-tools): first-class auto-sizing text label.
        # Requires a string `properties.text` (serializer-enforced, like the
        # line rules); whole-object styling rides `properties`
        # ({font_family, font_size, bold, italic, color}) and the row's
        # width/height MIRROR the client's auto-sized text box.
        TEXT = 'text', 'Text'

    floor_plan = models.ForeignKey(FloorPlan, on_delete=models.CASCADE, related_name='items')
    type = models.CharField(max_length=20, choices=ObjectType.choices)
    name = models.CharField(max_length=255, blank=True)

    # Grid-snapped canvas position and geometry
    x = models.FloatField()
    y = models.FloatField()
    width = models.FloatField(default=40)
    height = models.FloatField(default=40)
    rotation = models.FloatField(default=0)
    z_index = models.IntegerField(default=0, db_index=True)

    # Type-specific data (e.g. wall thickness, desk seat count, AC unit BTU,
    # Line points/curve_style, Shape kind-specific sizing)
    properties = models.JSONField(default=dict, blank=True)

    # U4 (canvas-tools): persistent-group membership tag. An OPAQUE,
    # CLIENT-generated identity (`group-<uuid4>`, ~42 chars) shared by every
    # member of one flat group — a plain writable passthrough with no
    # server-side ownership semantics, no FK, and never server-assigned
    # (client-generated identity keeps group keys valid inside frontend undo
    # snapshots with zero id-map involvement). NULL means ungrouped. Scoped,
    # like every field here, to the owning floor plan's own objects.
    group_key = models.CharField(max_length=64, null=True, blank=True, db_index=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f'{self.get_type_display()} ({self.x}, {self.y})'


def variant_upload_to(instance, filename):
    """Storage path for an ObjectVariant's file (U1, object-visuals).

    `uploads/user_<owner_id>/<uuid4hex>.<ext>` — the extension derives from
    the row's sniffed `kind`, NEVER from the client-supplied filename
    (`filename` is deliberately ignored: user filenames are untrusted and
    live only in `original_name` for display). Keys off `instance.owner_id`
    because upload_to runs BEFORE the row is saved — the variant's own pk
    does not exist yet, but the owner is already a persisted user. UUID
    names make files non-guessable and immutable-cacheable (U3), and can
    never collide with or overwrite another upload.
    """
    return f'uploads/user_{instance.owner_id}/{uuid.uuid4().hex}.{instance.kind}'


class ObjectVariant(models.Model):
    """A user's uploaded per-type visual (U1, object-visuals; R6-R9).

    Personal, cross-plan catalog entries: each row is one uploaded SVG/PNG/
    JPEG a user can place on any of their plans as a variant of one of the
    7 built-in catalog types. Placed canvas objects reference a variant by
    its id inside their `properties` JSON — an OPAQUE reference with no FK
    from Objects, the `group_key` precedent: rendering fails closed to the
    type's default symbol on a dangling/foreign reference, so referential
    integrity is deliberately not a database concern.
    """

    class Kind(models.TextChoices):
        # The sniffed (magic-byte-verified, U2) content kind — never the
        # client's claimed extension or Content-Type.
        SVG = 'svg', 'SVG'
        PNG = 'png', 'PNG'
        JPEG = 'jpeg', 'JPEG'

    # The 7 catalog types ONLY (reused from the Objects taxonomy). Shape/
    # line/text types are excluded by design: variants attach to catalog
    # cards in the sidebar; shapes/lines/text have no variant UI (plan
    # Scope Boundaries: "shapes/lines/text untouched").
    CATALOG_TYPE_CHOICES = [
        (Objects.ObjectType.OUTLINES.value, Objects.ObjectType.OUTLINES.label),
        (Objects.ObjectType.TABLES.value, Objects.ObjectType.TABLES.label),
        (Objects.ObjectType.DOORS.value, Objects.ObjectType.DOORS.label),
        (Objects.ObjectType.CHAIRS.value, Objects.ObjectType.CHAIRS.label),
        (Objects.ObjectType.FURNITURES.value, Objects.ObjectType.FURNITURES.label),
        (Objects.ObjectType.APPLIANCES.value, Objects.ObjectType.APPLIANCES.label),
        (Objects.ObjectType.LIGHTING.value, Objects.ObjectType.LIGHTING.label),
    ]

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='object_variants')
    object_type = models.CharField(max_length=20, choices=CATALOG_TYPE_CHOICES)

    # FileField, not ImageField — Pillow cannot parse SVG, and content
    # validation is the U2 pipeline's job, not the storage field's.
    file = models.FileField(upload_to=variant_upload_to, max_length=255)
    kind = models.CharField(max_length=4, choices=Kind.choices)

    # Natural (intrinsic) dimensions recorded by the U2 pipeline — rasters
    # post-re-encode, SVGs normalized from the viewBox. The frontend's
    # aspect-fit drop math reads these synchronously so image-load
    # completion never has to touch the canvas store.
    width = models.PositiveIntegerField()
    height = models.PositiveIntegerField()

    # Authoritative POST-pipeline size of the stored file. Rasters are
    # re-encoded through Pillow and SVGs are rewritten by svg-hush (U2), so
    # the upload's own byte count is NOT what lands on disk — the R19
    # per-user byte quota aggregates this column, and it must match storage.
    size_bytes = models.PositiveBigIntegerField()

    # Display only (thumbnails/tooltips, R12) — length-capped and
    # control-character-stripped at ingestion by U2. Never used for the
    # storage path (see variant_upload_to).
    original_name = models.CharField(max_length=255)

    # Soft delete IS the R11 mechanism: destroy flips this flag, hiding the
    # variant from the catalog list, while the owner-scoped file endpoint
    # keeps serving it — placed objects and historical undo snapshots keep
    # rendering forever. Files are never removed from disk in v1, and
    # inactive rows still count toward the R19 quota (retention stance).
    is_active = models.BooleanField(default=True)

    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f'{self.original_name} ({self.get_object_type_display()}, user {self.owner_id})'
