from django.contrib import admin

from .models import FloorPlan, FloorPlanItem


class FloorPlanItemInline(admin.TabularInline):
    model = FloorPlanItem
    extra = 0


@admin.register(FloorPlan)
class FloorPlanAdmin(admin.ModelAdmin):
    list_display = ('name', 'canvas_width', 'canvas_height', 'grid_size', 'updated_at')
    inlines = [FloorPlanItemInline]


@admin.register(FloorPlanItem)
class FloorPlanItemAdmin(admin.ModelAdmin):
    list_display = ('label', 'type', 'floor_plan', 'x', 'y', 'rotation')
    list_filter = ('type', 'floor_plan')
