from django.conf import settings
from django.db import models


class FloorPlan(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='floor_plans')
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
