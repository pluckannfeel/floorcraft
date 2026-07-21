from django.core.files.base import ContentFile
from django.http import Http404
from rest_framework import serializers

from . import variants
from .models import FloorPlan, Objects, ObjectVariant

LINE_TYPES = {
    Objects.ObjectType.LINE_STRAIGHT,
    Objects.ObjectType.LINE_CURVED,
    Objects.ObjectType.LINE_S_CURVE,
}

CURVED_LINE_TYPES = {
    Objects.ObjectType.LINE_CURVED,
    Objects.ObjectType.LINE_S_CURVE,
}


class OwnedFloorPlanField(serializers.PrimaryKeyRelatedField):
    """`floor_plan` reference field scoped to the requesting user (R2).

    Scoping the queryset (rather than checking ownership in `validate()`)
    makes a NONEXISTENT floor-plan pk and a FOREIGN-owned one fail
    identically — with the unscoped default queryset, a nonexistent pk
    fails field validation with 400 "Invalid pk" while a foreign pk fails
    the later ownership check, and that 400-vs-404 split is an existence
    oracle over floor-plan IDs (defeating R14's deliberate
    indistinguishability). It also inherently covers both create AND
    update — any payload carrying `floor_plan` passes through
    `to_internal_value` — closing the reassignment IDOR a create-only
    check would leave open.

    Failures raise Http404 (not ValidationError/400) so ownership
    failures look like "not found" (R14) and the frontend's global
    401/403 session-expiry interceptor can never misfire.

    Falls back to the unscoped queryset when no `request` is in context:
    `ObjectViewSet` (the only writable production call site) always
    supplies one via DRF's default `get_serializer_context()`, so this
    only affects serializer-level unit tests that instantiate
    `ObjectSerializer` directly — those aren't exercising the HTTP-level
    ownership boundary.
    """

    def get_queryset(self):
        request = self.context.get('request')
        if request is None or not getattr(request, 'user', None):
            return FloorPlan.objects.all()
        return FloorPlan.objects.filter(owner=request.user)

    def to_internal_value(self, data):
        try:
            return super().to_internal_value(data)
        except serializers.ValidationError:
            raise Http404


class ObjectSerializer(serializers.ModelSerializer):
    floor_plan = OwnedFloorPlanField()

    class Meta:
        model = Objects
        fields = [
            'id', 'floor_plan', 'type', 'name',
            'x', 'y', 'width', 'height', 'rotation', 'z_index',
            # `group_key` (U4) is a plain writable passthrough: an opaque
            # client-generated grouping tag (see models.py) with no
            # ownership semantics of its own — plan-level ownership already
            # gates every write path, and the key means nothing outside the
            # plan's own objects. SyncObjectSerializer inherits it.
            'properties', 'group_key', 'created_at', 'updated_at',
        ]

    def validate(self, attrs):
        """Validate `properties` against the selected `type` (R21/R22/R24/R27,
        and U7's text rule): Lines require a `points` array (curved lines
        also require a `curve_style`); Text objects require a string
        `properties.text` (the text content IS the object's substance — an
        item without it has nothing to render or edit); Shapes accept
        kind-specific sizing in `properties` beyond the shared
        width/height/rotation fields, with no additional required keys
        enforced here. (Ownership of the referenced `floor_plan` is enforced
        at the field level — see OwnedFloorPlanField.)
        """
        obj_type = attrs.get('type', getattr(self.instance, 'type', None))
        properties = attrs.get('properties', getattr(self.instance, 'properties', None))
        if properties is None:
            properties = {}

        if obj_type in LINE_TYPES:
            self._validate_line_properties(obj_type, properties)

        if obj_type == Objects.ObjectType.TEXT:
            self._validate_text_properties(properties)

        return attrs

    def _validate_text_properties(self, properties):
        """U7: mirrors `_validate_line_properties`' pattern for the `text`
        type — the styling keys ({font_family, font_size, bold, italic,
        color}) are deliberately NOT required (the frontend defaults any
        missing one), but the content itself must be a real string.
        """
        if not isinstance(properties, dict):
            raise serializers.ValidationError({
                'properties': 'Text objects require a properties object.',
            })
        if not isinstance(properties.get('text'), str):
            raise serializers.ValidationError({
                'properties': "Text objects require a string 'text' value.",
            })

    def _validate_line_properties(self, obj_type, properties):
        if not isinstance(properties, dict):
            raise serializers.ValidationError({
                'properties': 'Line objects require a properties object.',
            })

        points = properties.get('points')
        if not isinstance(points, list) or len(points) < 2:
            raise serializers.ValidationError({
                'properties': "Line objects require a 'points' array with at least 2 points.",
            })
        for point in points:
            if not isinstance(point, dict) or 'x' not in point or 'y' not in point:
                raise serializers.ValidationError({
                    'properties': "Each entry in 'points' must be an object with 'x' and 'y' keys.",
                })

        if obj_type in CURVED_LINE_TYPES and not properties.get('curve_style'):
            raise serializers.ValidationError({
                'properties': "Curved line objects require a 'curve_style' value.",
            })


class SyncObjectSerializer(ObjectSerializer):
    """ObjectSerializer variant for the bulk-sync endpoint
    (PUT /api/floor-plans/<pk>/objects/). There the floor plan is resolved
    from the URL through the user-scoped queryset and passed via
    `serializer.save(floor_plan=plan)`, so `floor_plan` is read-only here:
    any `floor_plan` value inside a payload item is ignored, which both
    keeps the URL as the single source of truth and closes the
    cross-plan-reassignment hole a writable field would reopen in this
    flow. Output shape is unchanged (still the floor plan's pk).
    """

    floor_plan = serializers.PrimaryKeyRelatedField(read_only=True)


class ObjectVariantSerializer(serializers.ModelSerializer):
    """Upload/list serializer for ObjectVariant (U2, object-visuals;
    R6-R9, R12).

    `file` is WRITE-ONLY: reading back the raw stored bytes through the
    list API would both bloat every catalog fetch and bypass U3's hardened
    serving headers — consumers get `file_url` instead and stream the file
    through the authenticated endpoint.

    `owner` is deliberately omitted (the FloorPlanSerializer precedent):
    never client-writable, injected server-side via perform_create — a
    writable owner field would be a variant-donation/impersonation hole.

    Everything the pipeline derives (kind, width, height, size_bytes,
    original_name) is read-only to the client and injected by validate():
    the client's claims about its own upload are worthless — the sniffed/
    re-encoded truth is what lands on the row.
    """

    # FileField, NOT ImageField: Pillow cannot parse SVG, so DRF's
    # ImageField (which runs Pillow verification on everything) would
    # reject a third of the allowed formats. Content validation is the U2
    # pipeline's job (see validate()).
    file = serializers.FileField(write_only=True)
    file_url = serializers.SerializerMethodField()

    class Meta:
        model = ObjectVariant
        fields = [
            'id', 'object_type', 'file', 'width', 'height', 'size_bytes',
            'original_name', 'created_at', 'file_url',
        ]
        read_only_fields = ['width', 'height', 'size_bytes', 'original_name', 'created_at']

    def get_file_url(self, obj):
        # Built by URL convention — U3 owns the real route (see the
        # variant_file_url docstring for why this is not a reverse()).
        return variants.variant_file_url(obj.id)

    def validate(self, attrs):
        """Run the full U2 validation pipeline on the upload, mirroring
        ObjectSerializer's `_validate_<kind>` dispatch style: `validate()`
        stays a thin router, `_validate_upload` owns the work. On success
        the pipeline's OUTPUT replaces the client's bytes entirely —
        rasters store the Pillow re-encode, SVGs store svg-hush's filtered/
        normalized output; the original buffer is never persisted.
        """
        upload = attrs.get('file')
        processed = self._validate_upload(upload)

        # A fresh ContentFile of the pipeline's bytes: the name is a
        # placeholder — variant_upload_to ignores filenames and derives the
        # stored path from owner + uuid + the sniffed kind (U1).
        attrs['file'] = ContentFile(processed.content, name=f'variant.{processed.kind}')
        attrs['kind'] = processed.kind
        attrs['width'] = processed.width
        attrs['height'] = processed.height
        # Authoritative POST-pipeline size — what actually lands on disk,
        # and what the R19 byte quota aggregates (models.ObjectVariant).
        attrs['size_bytes'] = len(processed.content)
        attrs['original_name'] = variants.clean_original_name(
            upload.name, fallback=f'upload.{processed.kind}'
        )
        return attrs

    def _validate_upload(self, upload):
        """Pipeline order per the plan: extension allowlist (cheapest) ->
        per-format byte cap on the REPORTED size (before reading bytes into
        memory) -> magic-byte sniff -> the format branch (Pillow re-encode
        or the SVG scan/hush/normalize chain). Every VariantRejected
        carries its specific human message (format vs size vs
        active-content vs DOCTYPE — R9's friendly-rejection contract) and
        surfaces as a 400 on the `file` field.
        """
        try:
            extension = variants.check_extension(upload.name)
            variants.check_byte_cap(extension, upload.size)
            upload.seek(0)
            return variants.process_upload(upload.read())
        except variants.VariantRejected as rejected:
            raise serializers.ValidationError({'file': str(rejected)})


class FloorPlanSerializer(serializers.ModelSerializer):
    class Meta:
        model = FloorPlan
        # `owner` is deliberately omitted: it's not client-writable and the
        # frontend never needs to display it. It's set server-side via
        # perform_create() in FloorPlanViewSet.
        #
        # Nested `items` are also deliberately NOT serialized: the frontend
        # always fetches objects separately via /objects/?floor_plan=<id>,
        # so nesting them here only produced an N+1 on the dashboard's list
        # endpoint and shipped every object of every plan for a card grid
        # that renders name and dates.
        #
        # `real_size_per_grid_square` and `unit` (canvas-rulers-scale, U1)
        # are the two per-plan scale settings. Both carry model defaults,
        # so DRF marks them `required=False` and the create path is
        # unaffected; the `MinValueValidator(0.0001)` floor on the model
        # surfaces as a serializer `min_value`, rejecting a zero/negative
        # scale at this boundary.
        fields = [
            'id', 'name', 'grid_size', 'canvas_width', 'canvas_height',
            'real_size_per_grid_square', 'unit',
            'created_at', 'updated_at',
        ]
