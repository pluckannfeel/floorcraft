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


class SyncTextTests(SyncEndpointTestCase):
    """U7 (canvas-tools): the 14th `type` value, `text`. Text items must
    round-trip through sync (content + styling live in `properties`; the
    row's width/height mirror the client's auto-sized box), and a text item
    without a string `properties.text` fails per-index with 400 — the same
    aligned-errors contract the line rules established.
    """

    def test_text_object_round_trips_through_sync(self):
        self.login_as()
        properties = {
            'text': 'Meeting Room',
            'font_family': 'Georgia',
            'font_size': 24,
            'bold': True,
            'italic': False,
            'color': '#111827',
        }

        response = self.sync(self.floor_plan.id, [
            object_payload(
                id='local-text-1', type=Objects.ObjectType.TEXT, name='',
                x=100, y=80, width=132, height=24, properties=properties,
            ),
        ])

        self.assertEqual(response.status_code, 200)
        row = response.json()['objects'][0]
        self.assertEqual(row['type'], 'text')
        self.assertEqual(row['properties'], properties)
        self.assertEqual(row['width'], 132)
        self.assertEqual(row['height'], 24)

        # Persisted, not just echoed: a reload's GET sees the same content.
        stored = Objects.objects.get(floor_plan=self.floor_plan)
        self.assertEqual(stored.type, Objects.ObjectType.TEXT)
        self.assertEqual(stored.properties['text'], 'Meeting Room')

    def test_text_without_text_property_is_per_index_400_and_atomic(self):
        self.login_as()
        survivor = Objects.objects.create(
            floor_plan=self.floor_plan, type=Objects.ObjectType.TABLES,
            name='Survivor', x=0, y=0,
        )

        response = self.sync(self.floor_plan.id, [
            object_payload(id=survivor.id, name='Valid update'),
            object_payload(type=Objects.ObjectType.TEXT, name='Bad text', properties={}),
        ])

        self.assertEqual(response.status_code, 400)
        errors = response.json()['objects']
        self.assertEqual(len(errors), 2)
        self.assertEqual(errors[0], {})
        self.assertIn('properties', errors[1])

        # Nothing applied (atomicity holds for the text rule too).
        survivor.refresh_from_db()
        self.assertEqual(survivor.name, 'Survivor')
        self.assertEqual(Objects.objects.filter(floor_plan=self.floor_plan).count(), 1)

    def test_text_with_non_string_text_property_is_400(self):
        self.login_as()

        response = self.sync(self.floor_plan.id, [
            object_payload(type=Objects.ObjectType.TEXT, properties={'text': 42}),
        ])

        self.assertEqual(response.status_code, 400)
        self.assertIn('properties', response.json()['objects'][0])
        self.assertEqual(Objects.objects.filter(floor_plan=self.floor_plan).count(), 0)

    def test_empty_string_text_is_valid(self):
        """An empty string is still a STRING — the create-path's empty-draft
        abort is a frontend concern; the API contract only types the field.
        """
        self.login_as()

        response = self.sync(self.floor_plan.id, [
            object_payload(type=Objects.ObjectType.TEXT, properties={'text': ''}),
        ])

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['objects'][0]['properties']['text'], '')


class SyncCanvasTests(SyncEndpointTestCase):
    """U8 (canvas-tools crop): the sync payload's OPTIONAL `canvas` key
    updates the FloorPlan's dimensions inside the same transaction as the
    object writes -- a crop's dims and shifted coordinates persist
    atomically. Positive integers only; anything else is a per-request 400
    with nothing (dims OR objects) applied. Objects-only payloads stay
    valid, and the response envelope is unchanged by `canvas`.
    """

    def sync_with_canvas(self, floor_plan_id, objects, canvas):
        return self.client.put(
            f'/api/floor-plans/{floor_plan_id}/objects/',
            json.dumps({'objects': objects, 'canvas': canvas}),
            content_type='application/json',
        )

    def test_canvas_applies_with_objects_in_one_atomic_sync(self):
        """The crop save: dims shrink AND the shifted object persists, in
        one 200 whose envelope shape is unchanged.
        """
        self.login_as()
        row = Objects.objects.create(
            floor_plan=self.floor_plan, type=Objects.ObjectType.TABLES,
            name='Shifted table', x=300, y=200,
        )

        response = self.sync_with_canvas(self.floor_plan.id, [
            object_payload(id=row.id, name='Shifted table', x=200, y=120),
        ], {'width': 800, 'height': 600})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.json().keys()), {'objects', 'id_map'})

        self.floor_plan.refresh_from_db()
        self.assertEqual(self.floor_plan.canvas_width, 800)
        self.assertEqual(self.floor_plan.canvas_height, 600)
        row.refresh_from_db()
        self.assertEqual((row.x, row.y), (200, 120))

    def test_objects_only_payload_still_works_and_keeps_dims(self):
        """`canvas` is optional -- an old-style payload neither fails nor
        touches the stored dimensions.
        """
        self.login_as()
        original_width = self.floor_plan.canvas_width
        original_height = self.floor_plan.canvas_height

        response = self.sync(self.floor_plan.id, [object_payload(name='Plain')])

        self.assertEqual(response.status_code, 200)
        self.floor_plan.refresh_from_db()
        self.assertEqual(self.floor_plan.canvas_width, original_width)
        self.assertEqual(self.floor_plan.canvas_height, original_height)

    def test_invalid_canvas_is_400_and_nothing_applies(self):
        """Atomicity for the dims rule: a bad `canvas` poisons the WHOLE
        request -- the valid object update/create/delete from the same
        payload must not land either.
        """
        self.login_as()
        kept = Objects.objects.create(
            floor_plan=self.floor_plan, type=Objects.ObjectType.TABLES,
            name='Untouched', x=5, y=5,
        )
        doomed = Objects.objects.create(
            floor_plan=self.floor_plan, type=Objects.ObjectType.CHAIRS,
            name='Would-be-deleted', x=10, y=10,
        )
        original_width = self.floor_plan.canvas_width

        invalid_canvases = [
            {'width': 0, 'height': 600},        # non-positive
            {'width': -800, 'height': 600},     # negative
            {'width': 800},                     # missing height
            {'width': 'wide', 'height': 600},   # non-int
            {'width': 800.5, 'height': 600},    # float
            {'width': True, 'height': 600},     # bool (isinstance int!)
            ['800', '600'],                     # not an object
        ]
        for canvas in invalid_canvases:
            with self.subTest(canvas=canvas):
                response = self.sync_with_canvas(self.floor_plan.id, [
                    object_payload(id=kept.id, name='Should not stick'),
                    object_payload(name='Should not exist'),
                ], canvas)

                self.assertEqual(response.status_code, 400)
                self.assertIn('canvas', response.json())

                # Nothing applied: dims, update, create, and implied
                # delete all untouched.
                self.floor_plan.refresh_from_db()
                self.assertEqual(self.floor_plan.canvas_width, original_width)
                kept.refresh_from_db()
                self.assertEqual(kept.name, 'Untouched')
                self.assertTrue(Objects.objects.filter(id=doomed.id).exists())
                self.assertFalse(Objects.objects.filter(name='Should not exist').exists())

    def test_invalid_object_item_also_rolls_back_canvas(self):
        """The other atomicity direction: a bad OBJECT item means the valid
        `canvas` dims must not persist either.
        """
        self.login_as()
        original_width = self.floor_plan.canvas_width
        original_height = self.floor_plan.canvas_height

        response = self.sync_with_canvas(self.floor_plan.id, [
            # Invalid: line without points (ObjectSerializer's line rule).
            object_payload(type=Objects.ObjectType.LINE_STRAIGHT, name='Bad line', properties={}),
        ], {'width': 800, 'height': 600})

        self.assertEqual(response.status_code, 400)
        self.floor_plan.refresh_from_db()
        self.assertEqual(self.floor_plan.canvas_width, original_width)
        self.assertEqual(self.floor_plan.canvas_height, original_height)

    def test_foreign_plan_with_canvas_still_404s_and_changes_nothing(self):
        intruder = make_verified_user(email='canvas-intruder@example.com')
        FloorPlan.objects.create(name="Intruder's Plan", owner=intruder)
        self.login_as('canvas-intruder@example.com')
        original_width = self.floor_plan.canvas_width

        response = self.sync_with_canvas(self.floor_plan.id, [], {'width': 10, 'height': 10})

        self.assertEqual(response.status_code, 404)
        self.floor_plan.refresh_from_db()
        self.assertEqual(self.floor_plan.canvas_width, original_width)


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
