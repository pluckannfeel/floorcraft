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


class ObjectSerializer(serializers.ModelSerializer):
    class Meta:
        model = Objects
        fields = [
            'id', 'floor_plan', 'type', 'name',
            'x', 'y', 'width', 'height', 'rotation', 'z_index',
            'properties', 'created_at', 'updated_at',
        ]

    def validate(self, attrs):
        """Validate `properties` against the selected `type` (R21/R22/R24/R27):
        Lines require a `points` array (curved lines also require a
        `curve_style`); Shapes accept kind-specific sizing in `properties`
        beyond the shared width/height/rotation fields, with no additional
        required keys enforced here.
        """
        self._validate_floor_plan_ownership(attrs)

        obj_type = attrs.get('type', getattr(self.instance, 'type', None))
        properties = attrs.get('properties', getattr(self.instance, 'properties', None))
        if properties is None:
            properties = {}

        if obj_type in LINE_TYPES:
            self._validate_line_properties(obj_type, properties)

        return attrs

    def _validate_floor_plan_ownership(self, attrs):
        """Reject any create/update payload that references a `floor_plan`
        the requesting user doesn't own (R2).

        `floor_plan` is a plain writable PrimaryKeyRelatedField, so this
        must run on both create AND update — otherwise a user could PATCH
        an object they already own to reassign its `floor_plan` to another
        user's plan (an IDOR via the update path, not just create).

        Raising Http404 (rather than a normal ValidationError, which would
        surface as 400) is deliberate: R14 requires ownership failures to
        look like "not found," not "bad request" or "forbidden," so the
        frontend's global 401/403 session-expiry interceptor never misfires
        on a foreign-object write attempt.

        Skipped entirely when no `request` is in context: `ObjectViewSet`
        (the only writable production call site) always supplies one via
        DRF's default `get_serializer_context()`, so this only affects
        serializer-level unit tests that instantiate `ObjectSerializer`
        directly without a request -- those aren't exercising the
        HTTP-level ownership boundary this check enforces.
        """
        if 'floor_plan' not in attrs:
            return

        request = self.context.get('request')
        if request is None:
            return

        floor_plan = attrs['floor_plan']
        user = getattr(request, 'user', None)
        if floor_plan is None or user is None or floor_plan.owner_id != user.id:
            raise Http404

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


class FloorPlanSerializer(serializers.ModelSerializer):
    items = ObjectSerializer(many=True, read_only=True)

    class Meta:
        model = FloorPlan
        # `owner` is deliberately omitted: it's not client-writable and the
        # frontend never needs to display it. It's set server-side via
        # perform_create() in FloorPlanViewSet.
        fields = [
            'id', 'name', 'grid_size', 'canvas_width', 'canvas_height',
            'items', 'created_at', 'updated_at',
        ]
