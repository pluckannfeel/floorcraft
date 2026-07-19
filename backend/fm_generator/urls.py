from rest_framework.routers import DefaultRouter

from .views import FloorPlanViewSet, ObjectVariantViewSet, ObjectViewSet

router = DefaultRouter()
router.register('floor-plans', FloorPlanViewSet)
router.register('objects', ObjectViewSet)
# U2 (object-visuals): the personal variant catalog — list/upload/soft-delete
# at /api/object-variants/. U3 adds the authenticated `file` action on the
# same route (the serializer's `file_url` convention already points there).
router.register('object-variants', ObjectVariantViewSet)

urlpatterns = router.urls
