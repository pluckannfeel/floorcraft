from django.db import transaction
from django.db.models import Count, Sum
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from . import variants
from .models import FloorPlan, Objects, ObjectVariant
from .serializers import (
    FloorPlanSerializer,
    ObjectSerializer,
    ObjectVariantSerializer,
    SyncObjectSerializer,
)


def _validate_canvas(canvas):
    """Validates sync_objects' optional `canvas` value (U8 crop): must be an
    object carrying positive-integer `width` and `height`. Returns an error
    message, or None when valid. Booleans are explicitly rejected (Python
    bools pass isinstance(int) checks), matching the id-matching rule's
    bool guard.
    """
    if not isinstance(canvas, dict):
        return 'Expected an object of the form {"width": <int>, "height": <int>}.'
    for key in ('width', 'height'):
        value = canvas.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            return f"'{key}' must be a positive integer."
    return None


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

        U8 (canvas-tools crop): the payload may also carry an OPTIONAL
        `canvas: {"width": <int>, "height": <int>}` -- the plan's canvas
        dimensions, applied to the FloorPlan row inside the SAME
        transaction as the object writes, so a crop's dims and its shifted
        coordinates persist atomically (or not at all). Positive integers
        only; anything else is a per-request 400 with nothing applied.
        Objects-only payloads (no `canvas` key) remain valid -- the field
        exists for backward compatibility, the current frontend always
        sends it.

        All items are validated up front (no writes yet); any per-item
        error returns 400 with errors aligned to the payload's indexes and
        persists nothing. The writes themselves run inside one
        transaction.atomic(). Responds 200 (shape unchanged by `canvas`)
        with:
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

        # U8: optional canvas dims -- validated up front like the items, so
        # a malformed `canvas` 400s before anything (objects included) is
        # written. `None` (key absent) skips the dims update entirely.
        canvas = request.data.get('canvas')
        if canvas is not None:
            canvas_error = _validate_canvas(canvas)
            if canvas_error is not None:
                return Response(
                    {'canvas': [canvas_error]},
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
            # U8: dims and objects persist in the SAME transaction -- a
            # crop's canvas resize can never land without its shifted
            # coordinates (or vice versa). `updated_at` is auto_now, which
            # only refreshes when named in update_fields.
            if canvas is not None:
                plan.canvas_width = canvas['width']
                plan.canvas_height = canvas['height']
                plan.save(update_fields=['canvas_width', 'canvas_height', 'updated_at'])
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


class ObjectVariantViewSet(
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    """The variant catalog API (U2, object-visuals): list / upload /
    soft-delete. Deliberately NOT a ModelViewSet — variants are immutable
    once uploaded (no update/partial_update; replacing a visual means
    uploading a new variant, R7's "never replace"), and retrieve is owned
    by U3's file action.
    """

    queryset = ObjectVariant.objects.all()
    serializer_class = ObjectVariantSerializer
    permission_classes = [IsAuthenticated]
    # Uploads arrive as multipart/form-data (a file plus object_type);
    # FormParser covers plain form posts. JSON has no business here.
    parser_classes = [MultiPartParser, FormParser]

    def get_queryset(self):
        """Owner-scoped ALWAYS (foreign/nonexistent ids 404 uniformly —
        the R14 anti-oracle pattern, same as FloorPlanViewSet). The
        `is_active` filter applies to LIST ONLY:

          * list is the catalog strip — soft-deleted variants are hidden
            from it (that IS the R18 delete semantic);
          * destroy must NOT filter on is_active, so deleting an
            already-deleted variant finds the row and succeeds again
            (idempotent 204, R18) instead of 404ing — while a foreign or
            nonexistent id still 404s via the owner scope.

        Ordering is stable (created_at, then id as the tiebreak for
        same-instant rows) so the catalog strip never reshuffles between
        fetches.
        """
        queryset = super().get_queryset().filter(owner=self.request.user)
        if self.action == 'list':
            queryset = queryset.filter(is_active=True)
        return queryset.order_by('created_at', 'id')

    def get_throttles(self):
        # R19: the rate limit guards the expensive action ONLY — uploads
        # burn CPU (Pillow/svg-hush) and disk; list/destroy are cheap and
        # throttling them would only hurt the catalog UI.
        if self.action == 'create':
            return [variants.VariantUploadThrottle()]
        return super().get_throttles()

    def perform_create(self, serializer):
        """Create with the ATOMIC quota check (R19; the plan's TOCTOU fix).

        A naive read-count-then-insert races: two concurrent uploads both
        read 99/100, both pass, both insert — 101. Instead, inside one
        transaction:

          1. `select_for_update()` over the owner's variant rows takes row
             locks. A concurrent creator for the SAME owner blocks HERE
             until this transaction commits (its FOR UPDATE scan conflicts
             with ours), so same-owner creates serialize. Ordered by pk so
             two lockers always acquire in the same order (no deadlock).
          2. The aggregate runs as a SECOND statement. Under READ COMMITTED
             each statement gets a fresh snapshot, so a transaction that
             was blocked in step 1 aggregates AFTER the winner's commit and
             sees its newly inserted row — the stale-read window is gone.

        The only unserialized case is an owner with ZERO variant rows (no
        rows, no locks) — harmless, since two concurrent first-uploads can
        never exceed either cap (2 <= 100 and 2 x 5 MB <= 100 MiB).

        Soft-deleted variants are deliberately INCLUDED (no is_active
        filter): their files persist on disk (retention stance), so they
        keep counting against both caps.
        """
        owner_variants = ObjectVariant.objects.filter(owner=self.request.user)
        with transaction.atomic():
            # Statement 1: acquire the locks (list() forces evaluation —
            # a lazy queryset would lock nothing). Postgres disallows
            # FOR UPDATE combined with aggregates, hence two statements.
            list(owner_variants.select_for_update().order_by('pk').values_list('pk', flat=True))

            # Statement 2: fresh-snapshot aggregate over count AND bytes.
            totals = owner_variants.aggregate(count=Count('pk'), total_bytes=Sum('size_bytes'))
            count = totals['count'] or 0
            total_bytes = totals['total_bytes'] or 0
            new_bytes = serializer.validated_data['size_bytes']
            if (
                count >= variants.MAX_VARIANT_COUNT
                or total_bytes + new_bytes > variants.MAX_VARIANT_TOTAL_BYTES
            ):
                # Friendly quota message (R19). The explicit list matches
                # the serializer-rejection shape ({"file": ["..."]}) —
                # DRF's ValidationError only listifies non-dict details, so
                # a bare string here would serialize as {"file": "..."}.
                raise ValidationError({'file': [variants.MSG_QUOTA]})

            serializer.save(owner=self.request.user)

    def perform_destroy(self, instance):
        # SOFT delete is the whole mechanism (R11/R18): the row survives,
        # the file survives, U3's file endpoint keeps serving it — placed
        # objects and undo snapshots keep rendering forever. Only the
        # catalog listing forgets it. Flipping an already-False flag is a
        # no-op write, which is what makes the second DELETE a clean 204.
        instance.is_active = False
        instance.save(update_fields=['is_active'])


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
