import json

from django.test import TestCase
from django.urls import reverse

from accounts.models import User
from fm_generator.models import FloorPlan, Objects

VALID_PASSWORD = 'Correct-Horse-9427!'


def make_verified_user(email='verified@example.com', password=VALID_PASSWORD):
    user = User.objects.create_user(email=email, password=password)
    user.is_active = True
    user.save()
    return user


def object_payload(**overrides):
    """A minimal valid sync payload item (a plain catalog object)."""
    item = {
        'type': Objects.ObjectType.TABLES,
        'name': 'Table',
        'x': 0,
        'y': 0,
        'width': 40,
        'height': 40,
        'rotation': 0,
        'z_index': 0,
        'properties': {},
    }
    item.update(overrides)
    return item


class SyncEndpointTestCase(TestCase):
    """Shared fixture/helpers for the bulk-sync endpoint
    (PUT /api/floor-plans/<pk>/objects/).
    """

    def setUp(self):
        self.user = make_verified_user()
        self.floor_plan = FloorPlan.objects.create(name='Sync Floor Plan', owner=self.user)

    def login_as(self, email='verified@example.com'):
        self.client.post(
            reverse('login'),
            {'email': email, 'password': VALID_PASSWORD},
            content_type='application/json',
        )

    def sync(self, floor_plan_id, objects):
        return self.client.put(
            f'/api/floor-plans/{floor_plan_id}/objects/',
            json.dumps({'objects': objects}),
            content_type='application/json',
        )


class SyncHappyPathTests(SyncEndpointTestCase):
    """One atomic PUT applies the full update/create/delete diff and returns
    the plan's canonical object list (same shape as
    GET /api/objects/?floor_plan=<id>).
    """

    def setUp(self):
        super().setUp()
        self.kept = Objects.objects.create(
            floor_plan=self.floor_plan, type=Objects.ObjectType.TABLES,
            name='Old table', x=0, y=0,
        )
        self.dropped = Objects.objects.create(
            floor_plan=self.floor_plan, type=Objects.ObjectType.CHAIRS,
            name='Doomed chair', x=10, y=10,
        )

    def test_mixed_payload_updates_creates_and_deletes(self):
        self.login_as()

        response = self.sync(self.floor_plan.id, [
            object_payload(id=self.kept.id, name='Renamed table', x=99),
            # New object carrying a frontend-local string id: must be treated
            # as a create and the local id discarded for a real one.
            object_payload(id='local-abc', type=Objects.ObjectType.DOORS, name='New door'),
        ])

        self.assertEqual(response.status_code, 200)
        body = response.json()['objects']
        self.assertEqual(len(body), 2)

        # Update applied.
        self.kept.refresh_from_db()
        self.assertEqual(self.kept.name, 'Renamed table')
        self.assertEqual(self.kept.x, 99)

        # Omitted object deleted.
        self.assertFalse(Objects.objects.filter(id=self.dropped.id).exists())

        # Create got a real (integer) id on this plan, not the local one.
        created = Objects.objects.get(floor_plan=self.floor_plan, name='New door')
        self.assertIsInstance(created.id, int)
        self.assertNotEqual(created.id, self.dropped.id)

        # Response is the canonical DB state for this plan.
        returned_ids = {row['id'] for row in body}
        self.assertEqual(returned_ids, {self.kept.id, created.id})
        self.assertTrue(all(row['floor_plan'] == self.floor_plan.id for row in body))
        self.assertEqual(Objects.objects.filter(floor_plan=self.floor_plan).count(), 2)

        # id_map: the created item's sent local id maps to its real id;
        # the updated item contributes no entry.
        self.assertEqual(response.json()['id_map'], {'local-abc': created.id})

    def test_payload_floor_plan_value_is_ignored(self):
        """The plan comes from the URL; a floor_plan key inside an item --
        even one pointing at another plan -- must not move the object.
        """
        other_plan = FloorPlan.objects.create(name='Other plan', owner=self.user)
        self.login_as()

        response = self.sync(self.floor_plan.id, [
            object_payload(id=self.kept.id, name='Still here', floor_plan=other_plan.id),
        ])

        self.assertEqual(response.status_code, 200)
        self.kept.refresh_from_db()
        self.assertEqual(self.kept.floor_plan_id, self.floor_plan.id)
        self.assertEqual(Objects.objects.filter(floor_plan=other_plan).count(), 0)

    def test_empty_objects_list_deletes_everything(self):
        self.login_as()

        response = self.sync(self.floor_plan.id, [])

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'objects': [], 'id_map': {}})
        self.assertEqual(Objects.objects.filter(floor_plan=self.floor_plan).count(), 0)

    def test_missing_objects_key_returns_400(self):
        self.login_as()

        response = self.client.put(
            f'/api/floor-plans/{self.floor_plan.id}/objects/',
            json.dumps({'items': []}),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 400)


class SyncOrderingTests(SyncEndpointTestCase):
    """The 200 response is ordered by (z_index, id), matching
    GET /api/objects/?floor_plan=<id>.
    """

    def test_response_ordered_by_z_index_then_id(self):
        self.login_as()

        # Created in payload order, so ids ascend a < b < c while z_index
        # values (2, 1, 1) are deliberately out of order, exercising the id
        # secondary sort key for the two z_index=1 rows.
        response = self.sync(self.floor_plan.id, [
            object_payload(name='z2', z_index=2),
            object_payload(name='z1-first', z_index=1),
            object_payload(name='z1-second', z_index=1),
        ])

        self.assertEqual(response.status_code, 200)
        body = response.json()['objects']
        self.assertEqual([row['name'] for row in body], ['z1-first', 'z1-second', 'z2'])
        self.assertEqual([row['z_index'] for row in body], [1, 1, 2])
        z1_ids = [row['id'] for row in body[:2]]
        self.assertEqual(z1_ids, sorted(z1_ids))


class SyncAtomicityTests(SyncEndpointTestCase):
    """The atomicity proof: one invalid item poisons the entire sync --
    the valid update, create, AND implied delete from the same payload must
    all be rolled back / never applied.
    """

    def setUp(self):
        super().setUp()
        self.kept = Objects.objects.create(
            floor_plan=self.floor_plan, type=Objects.ObjectType.TABLES,
            name='Untouched table', x=5, y=5,
        )
        self.dropped = Objects.objects.create(
            floor_plan=self.floor_plan, type=Objects.ObjectType.CHAIRS,
            name='Would-be-deleted chair', x=10, y=10,
        )

    def test_one_invalid_item_persists_nothing(self):
        self.login_as()

        response = self.sync(self.floor_plan.id, [
            object_payload(id=self.kept.id, name='Should not stick'),   # valid update
            object_payload(name='Should not exist'),                    # valid create
            # Invalid: line without points (ObjectSerializer's line rule).
            object_payload(type=Objects.ObjectType.LINE_STRAIGHT, name='Bad line', properties={}),
        ])

        self.assertEqual(response.status_code, 400)

        # Per-item errors: the two valid items are clean, the bad one names
        # the offending field.
        errors = response.json()['objects']
        self.assertEqual(len(errors), 3)
        self.assertEqual(errors[0], {})
        self.assertEqual(errors[1], {})
        self.assertIn('properties', errors[2])

        # DB completely unchanged: no update, no create, no delete.
        self.kept.refresh_from_db()
        self.assertEqual(self.kept.name, 'Untouched table')
        self.assertTrue(Objects.objects.filter(id=self.dropped.id).exists())
        self.assertEqual(Objects.objects.filter(floor_plan=self.floor_plan).count(), 2)
        self.assertFalse(Objects.objects.filter(name='Should not exist').exists())


class SyncOwnershipTests(SyncEndpointTestCase):
    """R2/R14 carried over to the sync endpoint: foreign/nonexistent plans
    404, and a foreign object id smuggled into the payload can never mutate
    the foreign object.
    """

    def setUp(self):
        super().setUp()
        self.intruder = make_verified_user(email='intruder@example.com')
        self.intruder_plan = FloorPlan.objects.create(name="Intruder's Plan", owner=self.intruder)
        self.victim_object = Objects.objects.create(
            floor_plan=self.floor_plan, type=Objects.ObjectType.OUTLINES,
            name='Victim outline', x=0, y=0,
        )

    def test_foreign_plan_pk_returns_404_and_changes_nothing(self):
        self.login_as('intruder@example.com')

        response = self.sync(self.floor_plan.id, [])

        self.assertEqual(response.status_code, 404)
        self.assertTrue(Objects.objects.filter(id=self.victim_object.id).exists())

    def test_nonexistent_plan_pk_returns_404(self):
        self.login_as('intruder@example.com')

        response = self.sync(999999, [])

        self.assertEqual(response.status_code, 404)

    def test_foreign_object_id_in_payload_cannot_mutate_foreign_object(self):
        """An integer id belonging to ANOTHER user's plan is not an update
        target: by the matching rule it falls into "create", so the caller
        gets a fresh object on their own plan and the victim row is
        untouched.
        """
        self.login_as('intruder@example.com')

        response = self.sync(self.intruder_plan.id, [
            object_payload(id=self.victim_object.id, name='Hijack attempt', x=77),
        ])

        self.assertEqual(response.status_code, 200)

        # Victim object untouched, still on its original plan.
        self.victim_object.refresh_from_db()
        self.assertEqual(self.victim_object.name, 'Victim outline')
        self.assertEqual(self.victim_object.x, 0)
        self.assertEqual(self.victim_object.floor_plan_id, self.floor_plan.id)

        # The item became a brand-new object on the caller's own plan.
        body = response.json()['objects']
        self.assertEqual(len(body), 1)
        self.assertNotEqual(body[0]['id'], self.victim_object.id)
        self.assertEqual(body[0]['floor_plan'], self.intruder_plan.id)
        self.assertEqual(body[0]['name'], 'Hijack attempt')

        # The unmatched integer id is still reported in id_map so the
        # caller can re-point its client-side identity at the new row.
        self.assertEqual(
            response.json()['id_map'], {str(self.victim_object.id): body[0]['id']},
        )


class SyncIdMapTests(SyncEndpointTestCase):
    """The id_map contract backing undo/redo-across-saves on the frontend:
    every CREATE that carried a sent id (local string, or a stale integer
    from a row a previous save deleted) reports sent-id -> created-id.
    """

    def test_stale_own_id_resurrects_as_new_row_with_mapping(self):
        """The redo-after-save flow: save deletes a row (undo removed it),
        redo brings the item back client-side still carrying the dead id,
        and the next save must recreate it and say where it went.
        """
        self.login_as()
        row = Objects.objects.create(
            floor_plan=self.floor_plan, type=Objects.ObjectType.TABLES,
            name='Twice-born table', x=1, y=2,
        )
        dead_id = row.id

        # Save #1: payload omits the row -> deleted.
        response = self.sync(self.floor_plan.id, [])
        self.assertEqual(response.status_code, 200)
        self.assertFalse(Objects.objects.filter(id=dead_id).exists())

        # Save #2: the client redoes and sends the item under its dead id.
        response = self.sync(self.floor_plan.id, [
            object_payload(id=dead_id, name='Twice-born table', x=1, y=2),
        ])

        self.assertEqual(response.status_code, 200)
        body = response.json()
        new_id = body['objects'][0]['id']
        self.assertNotEqual(new_id, dead_id)
        self.assertEqual(body['id_map'], {str(dead_id): new_id})

    def test_updates_produce_no_id_map_entries(self):
        self.login_as()
        row = Objects.objects.create(
            floor_plan=self.floor_plan, type=Objects.ObjectType.TABLES,
            name='Stable table', x=0, y=0,
        )

        response = self.sync(self.floor_plan.id, [
            object_payload(id=row.id, name='Renamed'),
        ])

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['id_map'], {})


class SyncGroupKeyTests(SyncEndpointTestCase):
    """U4 (canvas-tools): `group_key` is an opaque CLIENT-generated grouping
    tag (`group-<uuid>`) and a plain writable passthrough on the serializer —
    the sync endpoint must round-trip it (persist AND return it), while
    payloads that omit it or send an explicit null stay valid (ungrouped
    objects simply carry NULL). This is what lets grouped objects survive
    save + reload as a group (AE3).
    """

    def test_group_key_round_trips_through_sync(self):
        self.login_as()
        key = 'group-2f1f8a44-9c4e-4f6b-8d5e-0a1b2c3d4e5f'

        response = self.sync(self.floor_plan.id, [
            object_payload(id='local-a', name='Member A', group_key=key),
            object_payload(id='local-b', name='Member B', group_key=key),
            object_payload(id='local-c', name='Loose'),
        ])

        self.assertEqual(response.status_code, 200)
        by_name = {row['name']: row for row in response.json()['objects']}
        self.assertEqual(by_name['Member A']['group_key'], key)
        self.assertEqual(by_name['Member B']['group_key'], key)
        self.assertIsNone(by_name['Loose']['group_key'])

        # Persisted, not just echoed back: the rows carry the key in the DB,
        # so the next GET (a reload) returns the group intact.
        self.assertEqual(
            Objects.objects.filter(floor_plan=self.floor_plan, group_key=key).count(), 2,
        )

    def test_absent_and_null_group_key_are_both_allowed(self):
        self.login_as()

        response = self.sync(self.floor_plan.id, [
            object_payload(name='No key at all'),
            object_payload(name='Explicit null', group_key=None),
        ])

        self.assertEqual(response.status_code, 200)
        for row in response.json()['objects']:
            self.assertIsNone(row['group_key'])
        self.assertEqual(
            Objects.objects.filter(floor_plan=self.floor_plan, group_key__isnull=True).count(), 2,
        )

    def test_sync_clears_an_existing_group_key(self):
        """The ungroup-then-save flow: an update item sent with
        group_key=null must clear the stored key, not silently keep it.
        """
        self.login_as()
        row = Objects.objects.create(
            floor_plan=self.floor_plan, type=Objects.ObjectType.TABLES,
            name='Formerly grouped', x=0, y=0, group_key='group-old',
        )

        response = self.sync(self.floor_plan.id, [
            object_payload(id=row.id, name='Formerly grouped', group_key=None),
        ])

        self.assertEqual(response.status_code, 200)
        row.refresh_from_db()
        self.assertIsNone(row.group_key)
        self.assertIsNone(response.json()['objects'][0]['group_key'])


class SyncAuthenticationTests(SyncEndpointTestCase):
    """Matches the existing endpoints' behavior: without a session the
    request is rejected (401/403, per SessionAuthentication + the global
    IsAuthenticated default) and nothing changes.
    """

    def test_unauthenticated_request_is_rejected(self):
        Objects.objects.create(
            floor_plan=self.floor_plan, type=Objects.ObjectType.TABLES,
            name='Survivor', x=0, y=0,
        )

        response = self.sync(self.floor_plan.id, [])

        self.assertIn(response.status_code, (401, 403))
        self.assertEqual(Objects.objects.filter(floor_plan=self.floor_plan).count(), 1)
