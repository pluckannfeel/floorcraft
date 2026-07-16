from django.db import transaction
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import FloorPlan, Objects
from .serializers import FloorPlanSerializer, ObjectSerializer, SyncObjectSerializer


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

    @action(detail=True, methods=['put'], url_path='objects')
    def sync_objects(self, request, pk=None):
        """Atomic bulk sync for the explicit-Save flow.

        PUT /api/floor-plans/<pk>/objects/ with {"objects": [...]} replaces
        the plan's object set in one shot:
          - a payload item whose integer `id` matches one of THIS plan's
            objects -> full update of that object;
          - any other item (no id, a frontend-local string id like
            "local-abc", or an id belonging to another plan/user) -> create
            on this plan, ignoring the sent id -- so a foreign id can never
            mutate a foreign row;
          - existing objects absent from the payload -> deleted.

        All items are validated up front (no writes yet); any per-item
        error returns 400 with errors aligned to the payload's indexes and
        persists nothing. The writes themselves run inside one
        transaction.atomic(). Responds 200 with:
          {"objects": [...], "id_map": {"<sent id>": <created id>, ...}}
        where "objects" is the plan's canonical object list ordered by
        (z_index, id) (item shape identical to
        GET /api/objects/?floor_plan=<pk>), and "id_map" records, for every
        payload item that resulted in a CREATE and carried an `id` value
        (a frontend-local string id like "local-abc", or a stale integer id
        whose row no longer exists), which real id its row was created
        under. The frontend uses this to translate its stable client-side
        ids to server ids on subsequent saves WITHOUT rewriting its undo
        history (see useObjects.ts's useSaveObjects).
        """
        plan = self.get_object()  # user-scoped -> foreign/nonexistent pk 404s (R14)

        items = request.data.get('objects') if isinstance(request.data, dict) else None
        if not isinstance(items, list):
            return Response(
                {'objects': ['Expected a payload of the form {"objects": [...]}.']},
                status=status.HTTP_400_BAD_REQUEST,
            )

        existing = {obj.id: obj for obj in plan.items.all()}
        context = self.get_serializer_context()

        item_serializers = []
        sent_ids = []  # aligned with item_serializers; the raw payload id (or None)
        errors = []
        has_errors = False
        for item in items:
            item_id = item.get('id') if isinstance(item, dict) else None
            is_update = (
                isinstance(item_id, int)
                and not isinstance(item_id, bool)
                and item_id in existing
            )
            serializer = SyncObjectSerializer(
                existing[item_id] if is_update else None, data=item, context=context,
            )
            if serializer.is_valid():
                item_serializers.append(serializer)
                sent_ids.append(item_id)
                errors.append({})
            else:
                has_errors = True
                errors.append(serializer.errors)

        if has_errors:
            # Per-item errors aligned with the payload ({} = valid item).
            # Nothing has been written yet, so nothing needs rolling back.
            return Response({'objects': errors}, status=status.HTTP_400_BAD_REQUEST)

        id_map = {}
        with transaction.atomic():
            keep_ids = [s.instance.id for s in item_serializers if s.instance is not None]
            plan.items.exclude(id__in=keep_ids).delete()
            for serializer, sent_id in zip(item_serializers, sent_ids):
                was_create = serializer.instance is None
                obj = serializer.save(floor_plan=plan)
                if was_create and sent_id is not None:
                    id_map[str(sent_id)] = obj.id

        canonical = plan.items.order_by('z_index', 'id')
        return Response({
            'objects': ObjectSerializer(canonical, many=True, context=context).data,
            'id_map': id_map,
        })


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
