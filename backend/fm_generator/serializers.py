from rest_framework import serializers

from .models import FloorPlan, FloorPlanItem


class FloorPlanItemSerializer(serializers.ModelSerializer):
    class Meta:
        model = FloorPlanItem
        fields = [
            'id', 'floor_plan', 'type', 'label',
            'x', 'y', 'width', 'height', 'rotation',
            'properties', 'created_at', 'updated_at',
        ]


class FloorPlanSerializer(serializers.ModelSerializer):
    items = FloorPlanItemSerializer(many=True, read_only=True)

    class Meta:
        model = FloorPlan
        fields = [
            'id', 'name', 'grid_size', 'canvas_width', 'canvas_height',
            'items', 'created_at', 'updated_at',
        ]
