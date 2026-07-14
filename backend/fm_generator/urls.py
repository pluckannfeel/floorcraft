from rest_framework.routers import DefaultRouter

from .views import FloorPlanViewSet, FloorPlanItemViewSet

router = DefaultRouter()
router.register('floor-plans', FloorPlanViewSet)
router.register('floor-plan-items', FloorPlanItemViewSet)

urlpatterns = router.urls
