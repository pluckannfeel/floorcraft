from rest_framework import viewsets
from rest_framework.permissions import IsAuthenticated

from .models import FloorPlan, Objects
from .serializers import FloorPlanSerializer, ObjectSerializer


class FloorPlanViewSet(viewsets.ModelViewSet):
    queryset = FloorPlan.objects.all()
    serializer_class = FloorPlanSerializer
    permission_classes = [IsAuthenticated]


class ObjectViewSet(viewsets.ModelViewSet):
    queryset = Objects.objects.order_by('z_index', 'id')
    serializer_class = ObjectSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        queryset = super().get_queryset()
        floor_plan_id = self.request.query_params.get('floor_plan')
        if floor_plan_id is not None:
            queryset = queryset.filter(floor_plan_id=floor_plan_id)
        return queryset
