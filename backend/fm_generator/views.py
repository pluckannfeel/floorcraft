from rest_framework import viewsets
from rest_framework.permissions import IsAuthenticated

from .models import FloorPlan, Objects
from .serializers import FloorPlanSerializer, ObjectSerializer


class FloorPlanViewSet(viewsets.ModelViewSet):
    queryset = FloorPlan.objects.all()
    serializer_class = FloorPlanSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        # Scoping to the requesting user means DRF's default get_object()
        # naturally 404s (not 403) for rows outside this queryset (R2, R14).
        return super().get_queryset().filter(owner=self.request.user)

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)


class ObjectViewSet(viewsets.ModelViewSet):
    queryset = Objects.objects.order_by('z_index', 'id')
    serializer_class = ObjectSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        # Objects have no owner of their own; they inherit ownership scoping
        # from their parent floor plan (R2). This also makes direct-ID
        # access (retrieve/update/destroy) 404 for objects on a floor plan
        # the requesting user doesn't own, not just the list/query-param path.
        queryset = super().get_queryset().filter(floor_plan__owner=self.request.user)
        floor_plan_id = self.request.query_params.get('floor_plan')
        if floor_plan_id is not None:
            queryset = queryset.filter(floor_plan_id=floor_plan_id)
        return queryset
