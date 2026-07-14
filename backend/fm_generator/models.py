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


class FloorPlanItem(models.Model):
    class ItemType(models.TextChoices):
        DESK = 'desk', 'Desk'
        WALL = 'wall', 'Wall'
        AC_UNIT = 'ac_unit', 'AC Unit'
        LIGHT = 'light', 'Lighting Node'

    floor_plan = models.ForeignKey(FloorPlan, on_delete=models.CASCADE, related_name='items')
    type = models.CharField(max_length=20, choices=ItemType.choices)
    label = models.CharField(max_length=255, blank=True)

    # Grid-snapped canvas position and geometry
    x = models.FloatField()
    y = models.FloatField()
    width = models.FloatField(default=40)
    height = models.FloatField(default=40)
    rotation = models.FloatField(default=0)

    # Type-specific data (e.g. wall thickness, desk seat count, AC unit BTU)
    properties = models.JSONField(default=dict, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f'{self.get_type_display()} ({self.x}, {self.y})'
