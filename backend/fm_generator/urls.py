from rest_framework.routers import DefaultRouter

from .views import FloorPlanViewSet, ObjectViewSet

router = DefaultRouter()
router.register('floor-plans', FloorPlanViewSet)
router.register('objects', ObjectViewSet)

urlpatterns = router.urls
