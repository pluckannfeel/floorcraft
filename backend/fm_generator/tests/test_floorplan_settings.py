from django.test import TestCase

from fm_generator.models import FloorPlan
from fm_generator.serializers import FloorPlanSerializer

from .test_models import make_owner


class FloorPlanScaleUnitSerializerTests(TestCase):
    """U1 (canvas-rulers-scale): the two per-plan scale settings
    (`real_size_per_grid_square` + `unit`) persist and round-trip through
    `FloorPlanSerializer`, default to 1 square = 0.5 m / meters for rows
    created without them (R3/AE3), update independently, and reject an
    out-of-range scale or an out-of-choices unit at the serializer boundary
    (the `MinValueValidator` / `TextChoices` derive DRF validation).
    """

    def setUp(self):
        self.owner = make_owner()

    def test_both_fields_round_trip_through_serializer(self):
        """Happy path: setting explicit values validates, saves, and the
        serialized output reflects exactly what was set.
        """
        serializer = FloorPlanSerializer(data={
            'name': 'Scaled Plan',
            'real_size_per_grid_square': 1.25,
            'unit': FloorPlan.Unit.FEET_INCHES,
        })
        self.assertTrue(serializer.is_valid(), serializer.errors)
        floor_plan = serializer.save(owner=self.owner)

        floor_plan.refresh_from_db()
        self.assertEqual(floor_plan.real_size_per_grid_square, 1.25)
        self.assertEqual(floor_plan.unit, 'feet_inches')

        output = FloorPlanSerializer(floor_plan).data
        self.assertEqual(output['real_size_per_grid_square'], 1.25)
        self.assertEqual(output['unit'], 'feet_inches')

    def test_defaults_applied_when_fields_absent_from_payload(self):
        """Covers AE3: a plan created WITHOUT the scale fields in the
        payload gets the defaults (0.5, meters) — the create path is
        unaffected because default-bearing fields are `required=False`.
        """
        serializer = FloorPlanSerializer(data={'name': 'Defaulted Plan'})
        self.assertTrue(serializer.is_valid(), serializer.errors)
        floor_plan = serializer.save(owner=self.owner)

        floor_plan.refresh_from_db()
        self.assertEqual(floor_plan.real_size_per_grid_square, 0.5)
        self.assertEqual(floor_plan.unit, 'meters')

    def test_model_created_directly_serializes_with_defaults(self):
        """Covers AE3 (existing-row analogue): a row created straight
        through the model — the way a pre-existing/backfilled plan looks —
        serializes with the defaults present in its output.
        """
        floor_plan = FloorPlan.objects.create(name='Direct Plan', owner=self.owner)

        output = FloorPlanSerializer(floor_plan).data
        self.assertEqual(output['real_size_per_grid_square'], 0.5)
        self.assertEqual(output['unit'], 'meters')

    def test_partial_update_changes_real_size_independently(self):
        """Happy path (PATCH-style): a partial update touching only the
        scale value leaves `unit` untouched.
        """
        floor_plan = FloorPlan.objects.create(name='Patch Plan', owner=self.owner)

        serializer = FloorPlanSerializer(
            floor_plan, data={'real_size_per_grid_square': 2.0}, partial=True,
        )
        self.assertTrue(serializer.is_valid(), serializer.errors)
        serializer.save()

        floor_plan.refresh_from_db()
        self.assertEqual(floor_plan.real_size_per_grid_square, 2.0)
        self.assertEqual(floor_plan.unit, 'meters')

    def test_partial_update_changes_unit_independently(self):
        """Happy path (PATCH-style): a partial update touching only the
        unit leaves the scale value untouched.
        """
        floor_plan = FloorPlan.objects.create(name='Patch Plan', owner=self.owner)

        serializer = FloorPlanSerializer(
            floor_plan, data={'unit': FloorPlan.Unit.FEET_INCHES}, partial=True,
        )
        self.assertTrue(serializer.is_valid(), serializer.errors)
        serializer.save()

        floor_plan.refresh_from_db()
        self.assertEqual(floor_plan.unit, 'feet_inches')
        self.assertEqual(floor_plan.real_size_per_grid_square, 0.5)

    def test_zero_real_size_is_rejected(self):
        """Error path: a zero scale is rejected by the serializer-derived
        `min_value` (0.0001 floor) — it would divide-by-zero the rulers.
        """
        serializer = FloorPlanSerializer(data={
            'name': 'Bad Plan',
            'real_size_per_grid_square': 0,
        })
        self.assertFalse(serializer.is_valid())
        self.assertIn('real_size_per_grid_square', serializer.errors)

    def test_negative_real_size_is_rejected(self):
        """Error path: a negative scale is rejected by the serializer-
        derived `min_value`.
        """
        serializer = FloorPlanSerializer(data={
            'name': 'Bad Plan',
            'real_size_per_grid_square': -1.5,
        })
        self.assertFalse(serializer.is_valid())
        self.assertIn('real_size_per_grid_square', serializer.errors)

    def test_out_of_choices_unit_is_rejected(self):
        """Error path: a unit outside the two `TextChoices` values is
        rejected by the serializer.
        """
        serializer = FloorPlanSerializer(data={
            'name': 'Bad Plan',
            'unit': 'furlongs',
        })
        self.assertFalse(serializer.is_valid())
        self.assertIn('unit', serializer.errors)
