from rest_framework import viewsets

from .models import FloorPlan, FloorPlanItem
from .serializers import FloorPlanSerializer, FloorPlanItemSerializer


class FloorPlanViewSet(viewsets.ModelViewSet):
    queryset = FloorPlan.objects.all()
    serializer_class = FloorPlanSerializer


class FloorPlanItemViewSet(viewsets.ModelViewSet):
    queryset = FloorPlanItem.objects.all()
    serializer_class = FloorPlanItemSerializer

    def get_queryset(self):
        queryset = super().get_queryset()
        floor_plan_id = self.request.query_params.get('floor_plan')
        if floor_plan_id is not None:
            queryset = queryset.filter(floor_plan_id=floor_plan_id)
        return queryset
