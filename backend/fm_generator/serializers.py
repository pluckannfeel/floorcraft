from django.http import Http404
from rest_framework import serializers

from .models import FloorPlan, Objects

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
        """Validate `properties` against the selected `type` (R21/R22/R24/R27):
        Lines require a `points` array (curved lines also require a
        `curve_style`); Shapes accept kind-specific sizing in `properties`
        beyond the shared width/height/rotation fields, with no additional
        required keys enforced here. (Ownership of the referenced
        `floor_plan` is enforced at the field level — see
        OwnedFloorPlanField.)
        """
        obj_type = attrs.get('type', getattr(self.instance, 'type', None))
        properties = attrs.get('properties', getattr(self.instance, 'properties', None))
        if properties is None:
            properties = {}

        if obj_type in LINE_TYPES:
            self._validate_line_properties(obj_type, properties)

        return attrs

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
        fields = [
            'id', 'name', 'grid_size', 'canvas_width', 'canvas_height',
            'created_at', 'updated_at',
        ]
