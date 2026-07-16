from django.db import models


class FloorPlan(models.Model):
    name = models.CharField(max_length=255)
    grid_size = models.PositiveIntegerField(default=20)
    canvas_width = models.PositiveIntegerField(default=1600)
    canvas_height = models.PositiveIntegerField(default=1200)
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

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f'{self.get_type_display()} ({self.x}, {self.y})'
