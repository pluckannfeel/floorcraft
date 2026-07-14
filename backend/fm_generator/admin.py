from django.contrib import admin

from .models import FloorPlan, Objects


class ObjectsInline(admin.TabularInline):
    model = Objects
    extra = 0


@admin.register(FloorPlan)
class FloorPlanAdmin(admin.ModelAdmin):
    list_display = ('name', 'canvas_width', 'canvas_height', 'grid_size', 'updated_at')
    inlines = [ObjectsInline]


@admin.register(Objects)
class ObjectsAdmin(admin.ModelAdmin):
    list_display = ('name', 'type', 'floor_plan', 'x', 'y', 'z_index', 'rotation')
    list_filter = ('type', 'floor_plan')
