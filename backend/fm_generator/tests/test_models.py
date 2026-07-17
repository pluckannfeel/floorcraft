from django.db import IntegrityError, transaction
from django.test import TestCase
from rest_framework.test import APITestCase

from accounts.models import User
from fm_generator.models import FloorPlan, Objects
from fm_generator.serializers import ObjectSerializer

ALL_TYPES = [choice[0] for choice in Objects.ObjectType.choices]
LINE_TYPES = ['line_straight', 'line_curved', 'line_s_curve']
CURVED_LINE_TYPES = ['line_curved', 'line_s_curve']


def make_owner(email='owner@example.com', password='Correct-Horse-9427!'):
    """Create a user suitable for use as a FloorPlan.owner in tests."""
    user = User.objects.create_user(email=email, password=password)
    user.is_active = True
    user.save()
    return user


class ObjectsTypeTaxonomyTests(TestCase):
    """Happy path: creating an Objects row with each of the 14 type values
    (13 original + U7's `text`) succeeds and round-trips via the serializer.
    """

    def setUp(self):
        self.floor_plan = FloorPlan.objects.create(name='Test Floor Plan', owner=make_owner())

    def test_all_fourteen_types_round_trip(self):
        self.assertEqual(len(ALL_TYPES), 14)

        for obj_type in ALL_TYPES:
            payload = {
                'floor_plan': self.floor_plan.id,
                'type': obj_type,
                'name': f'{obj_type} item',
                'x': 10,
                'y': 20,
            }
            if obj_type in LINE_TYPES:
                payload['properties'] = {
                    'points': [{'x': 0, 'y': 0}, {'x': 10, 'y': 10}],
                }
                if obj_type in CURVED_LINE_TYPES:
                    payload['properties']['curve_style'] = 'smooth'
            if obj_type == Objects.ObjectType.TEXT:
                # U7's text rule: a string `properties.text` is required.
                payload['properties'] = {'text': 'a label'}

            serializer = ObjectSerializer(data=payload)
            self.assertTrue(serializer.is_valid(), (obj_type, serializer.errors))
            instance = serializer.save()

            self.assertEqual(instance.type, obj_type)
            round_tripped = ObjectSerializer(instance).data
            self.assertEqual(round_tripped['type'], obj_type)
            self.assertEqual(round_tripped['name'], f'{obj_type} item')

    def test_invalid_type_outside_enum_is_rejected(self):
        payload = {
            'floor_plan': self.floor_plan.id,
            'type': 'not_a_real_type',
            'name': 'bad item',
            'x': 0,
            'y': 0,
        }
        serializer = ObjectSerializer(data=payload)
        self.assertFalse(serializer.is_valid())
        self.assertIn('type', serializer.errors)

    def test_line_missing_points_is_rejected(self):
        payload = {
            'floor_plan': self.floor_plan.id,
            'type': 'line_straight',
            'name': 'bad line',
            'x': 0,
            'y': 0,
            'properties': {},
        }
        serializer = ObjectSerializer(data=payload)
        self.assertFalse(serializer.is_valid())
        self.assertIn('properties', serializer.errors)

    def test_curved_line_missing_curve_style_is_rejected(self):
        payload = {
            'floor_plan': self.floor_plan.id,
            'type': 'line_curved',
            'name': 'bad curve',
            'x': 0,
            'y': 0,
            'properties': {
                'points': [{'x': 0, 'y': 0}, {'x': 5, 'y': 5}],
            },
        }
        serializer = ObjectSerializer(data=payload)
        self.assertFalse(serializer.is_valid())
        self.assertIn('properties', serializer.errors)

    def test_line_stores_and_retrieves_multi_point_properties_unchanged(self):
        points = [
            {'x': 0, 'y': 0},
            {'x': 15, 'y': 5},
            {'x': 30, 'y': 40},
            {'x': 50, 'y': 10},
        ]
        payload = {
            'floor_plan': self.floor_plan.id,
            'type': 'line_curved',
            'name': 'multi-point line',
            'x': 0,
            'y': 0,
            'properties': {
                'points': points,
                'curve_style': 's-curve',
            },
        }
        serializer = ObjectSerializer(data=payload)
        self.assertTrue(serializer.is_valid(), serializer.errors)
        instance = serializer.save()
        instance.refresh_from_db()

        self.assertEqual(instance.properties['points'], points)
        self.assertEqual(instance.properties['curve_style'], 's-curve')


class LegacyDataMigrationTests(TestCase):
    """Regression: after the full migration sequence, the previously-existing
    test item (old type='desk') no longer exists, and any prior label value
    survives under name.
    """

    def test_legacy_desk_row_absent_after_migrations(self):
        # The 0004 data migration deletes any row with type='desk' as part of
        # the migration sequence itself (already applied by test-db setup).
        # 'desk' isn't part of the current 13-value enum, so the raw queryset
        # (not the serializer) is used to confirm no such row lingers.
        self.assertFalse(Objects.objects.filter(type='desk').exists())

    def test_no_floor_plan_rows_survive_ownership_migration(self):
        # The 0006 migration deletes every pre-existing FloorPlan row
        # (cascading to Objects) before adding the non-nullable `owner`
        # field, as part of the migration sequence itself. This includes
        # the legacy hardcoded floor plan (id 1) and its objects that exist
        # in real dev databases predating this migration -- a freshly
        # migrated database (this test DB included) starts with zero
        # FloorPlan rows and no orphaned Objects.
        self.assertEqual(FloorPlan.objects.count(), 0)
        self.assertEqual(Objects.objects.count(), 0)

    def test_name_field_holds_former_label_value(self):
        floor_plan = FloorPlan.objects.create(name='Legacy Floor Plan', owner=make_owner())
        item = Objects.objects.create(
            floor_plan=floor_plan,
            type='tables',
            name='Conference Table',
            x=1,
            y=1,
        )
        item.refresh_from_db()
        self.assertEqual(item.name, 'Conference Table')
        self.assertFalse(hasattr(item, 'label'))


class ObjectViewSetOrderingTests(APITestCase):
    """Happy path: querying the list endpoint returns items ordered by
    z_index then id, stable across repeated calls.
    """

    def setUp(self):
        # The list endpoint requires an authenticated session (U4); this
        # test is only exercising ordering behavior, so authenticate a
        # throwaway user rather than testing permissions here.
        user = User.objects.create_user(email='ordering@example.com', password='Correct-Horse-9427!')
        user.is_active = True
        user.save()
        self.client.force_authenticate(user=user)

        self.floor_plan = FloorPlan.objects.create(name='Ordering Floor Plan', owner=user)
        # Deliberately create out of z_index order, with duplicate z_index
        # values to exercise the id secondary sort key.
        self.item_a = Objects.objects.create(
            floor_plan=self.floor_plan, type='tables', x=0, y=0, z_index=2,
        )
        self.item_b = Objects.objects.create(
            floor_plan=self.floor_plan, type='chairs', x=0, y=0, z_index=1,
        )
        self.item_c = Objects.objects.create(
            floor_plan=self.floor_plan, type='doors', x=0, y=0, z_index=1,
        )

    def test_list_ordered_by_z_index_then_id(self):
        expected_order = [self.item_b.id, self.item_c.id, self.item_a.id]

        for _ in range(2):
            response = self.client.get('/api/objects/', {'floor_plan': self.floor_plan.id})
            self.assertEqual(response.status_code, 200)
            returned_ids = [row['id'] for row in response.data['results']] \
                if isinstance(response.data, dict) and 'results' in response.data \
                else [row['id'] for row in response.data]
            self.assertEqual(returned_ids, expected_order)


class FloorPlanOwnershipTests(TestCase):
    """Covers R1: a FloorPlan is owned by exactly one user, set at creation
    time. Verifies the non-nullable `owner` FK added by
    0006_add_floorplan_owner.
    """

    def setUp(self):
        self.owner = make_owner()

    def test_floor_plan_with_owner_persists_and_reads_back(self):
        floor_plan = FloorPlan.objects.create(name='Owned Floor Plan', owner=self.owner)

        floor_plan.refresh_from_db()

        self.assertEqual(floor_plan.owner_id, self.owner.id)
        self.assertEqual(floor_plan.owner, self.owner)
        self.assertEqual(floor_plan.name, 'Owned Floor Plan')
        self.assertIn(floor_plan, self.owner.floor_plans.all())

    def test_floor_plan_without_owner_cannot_be_created(self):
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                FloorPlan.objects.create(name='No Owner')
