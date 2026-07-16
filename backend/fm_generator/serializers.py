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
