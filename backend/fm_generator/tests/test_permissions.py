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


class FloorPlanPermissionTests(TestCase):
    """Covers AE3: the fm_generator API is only reachable with an
    authenticated session, now that IsAuthenticated is both the explicit
    viewset default and the global DRF default.
    """

    def setUp(self):
        # Distinct email from the per-test `make_verified_user()` calls
        # below (which use the default email to log in), so creating this
        # fixture's owner doesn't collide with those.
        owner = make_verified_user(email='floorplan-owner@example.com')
        self.floor_plan = FloorPlan.objects.create(name='Test Floor Plan', owner=owner)
        Objects.objects.create(
            floor_plan=self.floor_plan,
            type=Objects.ObjectType.OUTLINES,
            name='Outline 1',
            x=0,
            y=0,
        )

    def test_authenticated_request_to_floor_plans_succeeds(self):
        make_verified_user()
        self.client.post(
            reverse('login'),
            {'email': 'verified@example.com', 'password': VALID_PASSWORD},
            content_type='application/json',
        )

        response = self.client.get('/api/floor-plans/')

        self.assertEqual(response.status_code, 200)

    def test_unauthenticated_request_to_floor_plans_is_rejected(self):
        response = self.client.get('/api/floor-plans/')

        self.assertIn(response.status_code, (401, 403))

    def test_unauthenticated_request_to_objects_is_rejected(self):
        response = self.client.get('/api/objects/')

        self.assertIn(response.status_code, (401, 403))

    def test_authenticated_request_to_objects_succeeds(self):
        make_verified_user()
        self.client.post(
            reverse('login'),
            {'email': 'verified@example.com', 'password': VALID_PASSWORD},
            content_type='application/json',
        )

        response = self.client.get('/api/objects/')

        self.assertEqual(response.status_code, 200)


class CrossUserOwnershipScopingTests(TestCase):
    """Covers R2/R14: FloorPlanViewSet and ObjectViewSet are scoped to the
    requesting user's own data, and any ownership violation (wrong owner or
    nonexistent row) surfaces as 404 -- never 403/400, which could trip the
    frontend's global session-expiry interceptor (`frontend_ts/src/api/client.ts`).
    """

    def setUp(self):
        self.user_a = make_verified_user(email='user-a@example.com')
        self.user_b = make_verified_user(email='user-b@example.com')

        self.floor_plan_a = FloorPlan.objects.create(name="A's Floor Plan", owner=self.user_a)
        self.object_a = Objects.objects.create(
            floor_plan=self.floor_plan_a,
            type=Objects.ObjectType.OUTLINES,
            name='Outline A',
            x=0,
            y=0,
        )

        self.floor_plan_b = FloorPlan.objects.create(name="B's Floor Plan", owner=self.user_b)

    def login_as(self, email):
        self.client.post(
            reverse('login'),
            {'email': email, 'password': VALID_PASSWORD},
            content_type='application/json',
        )

    # -- Happy path ----------------------------------------------------

    def test_owner_can_list_retrieve_update_delete_own_floor_plan_and_objects(self):
        self.login_as('user-a@example.com')

        list_response = self.client.get('/api/floor-plans/')
        self.assertEqual(list_response.status_code, 200)
        self.assertIn(self.floor_plan_a.id, [row['id'] for row in list_response.json()])

        detail_url = f'/api/floor-plans/{self.floor_plan_a.id}/'
        retrieve_response = self.client.get(detail_url)
        self.assertEqual(retrieve_response.status_code, 200)
        self.assertEqual(retrieve_response.json()['id'], self.floor_plan_a.id)

        update_response = self.client.patch(
            detail_url, {'name': 'Renamed by owner'}, content_type='application/json',
        )
        self.assertEqual(update_response.status_code, 200)
        self.assertEqual(update_response.json()['name'], 'Renamed by owner')

        object_url = f'/api/objects/{self.object_a.id}/'
        object_list = self.client.get(f'/api/objects/?floor_plan={self.floor_plan_a.id}')
        self.assertEqual(object_list.status_code, 200)
        self.assertIn(self.object_a.id, [row['id'] for row in object_list.json()])

        object_retrieve = self.client.get(object_url)
        self.assertEqual(object_retrieve.status_code, 200)

        object_update = self.client.patch(
            object_url, {'name': 'Renamed object'}, content_type='application/json',
        )
        self.assertEqual(object_update.status_code, 200)
        self.assertEqual(object_update.json()['name'], 'Renamed object')

        object_delete = self.client.delete(object_url)
        self.assertEqual(object_delete.status_code, 204)

        delete_response = self.client.delete(detail_url)
        self.assertEqual(delete_response.status_code, 204)

    # -- Foreign floor plan (list/retrieve/update/delete) --------------

    def test_foreign_floor_plan_is_hidden_from_list(self):
        self.login_as('user-b@example.com')

        response = self.client.get('/api/floor-plans/')

        self.assertEqual(response.status_code, 200)
        self.assertNotIn(self.floor_plan_a.id, [row['id'] for row in response.json()])

    def test_foreign_floor_plan_retrieve_returns_404(self):
        self.login_as('user-b@example.com')

        response = self.client.get(f'/api/floor-plans/{self.floor_plan_a.id}/')

        self.assertEqual(response.status_code, 404)

    def test_foreign_floor_plan_update_returns_404_and_does_not_modify(self):
        self.login_as('user-b@example.com')

        response = self.client.patch(
            f'/api/floor-plans/{self.floor_plan_a.id}/',
            {'name': 'Hijacked'},
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 404)
        self.floor_plan_a.refresh_from_db()
        self.assertEqual(self.floor_plan_a.name, "A's Floor Plan")

    def test_foreign_floor_plan_delete_returns_404_and_does_not_delete(self):
        self.login_as('user-b@example.com')

        response = self.client.delete(f'/api/floor-plans/{self.floor_plan_a.id}/')

        self.assertEqual(response.status_code, 404)
        self.assertTrue(FloorPlan.objects.filter(id=self.floor_plan_a.id).exists())

    # -- Objects reachability via floor plan ----------------------------

    def test_foreign_floor_plan_objects_query_param_returns_empty(self):
        self.login_as('user-b@example.com')

        response = self.client.get(f'/api/objects/?floor_plan={self.floor_plan_a.id}')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])

    def test_foreign_object_direct_retrieve_returns_404(self):
        self.login_as('user-b@example.com')

        response = self.client.get(f'/api/objects/{self.object_a.id}/')

        self.assertEqual(response.status_code, 404)

    def test_foreign_object_direct_update_returns_404_and_does_not_modify(self):
        self.login_as('user-b@example.com')

        response = self.client.patch(
            f'/api/objects/{self.object_a.id}/',
            {'name': 'Hijacked object'},
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 404)
        self.object_a.refresh_from_db()
        self.assertEqual(self.object_a.name, 'Outline A')

    def test_foreign_object_direct_delete_returns_404_and_does_not_delete(self):
        self.login_as('user-b@example.com')

        response = self.client.delete(f'/api/objects/{self.object_a.id}/')

        self.assertEqual(response.status_code, 404)
        self.assertTrue(Objects.objects.filter(id=self.object_a.id).exists())

    def test_creating_object_on_foreign_floor_plan_returns_404(self):
        self.login_as('user-b@example.com')

        response = self.client.post(
            '/api/objects/',
            {
                'floor_plan': self.floor_plan_a.id,
                'type': Objects.ObjectType.OUTLINES,
                'name': 'Malicious Outline',
                'x': 0,
                'y': 0,
            },
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 404)
        self.assertFalse(
            Objects.objects.filter(floor_plan=self.floor_plan_a, name='Malicious Outline').exists()
        )

    # -- IDOR: reassigning an owned object's floor_plan on update -------

    def test_reassigning_owned_object_to_foreign_floor_plan_is_rejected(self):
        """The critical regression test for this unit: user A owns
        `object_a`, and tries to PATCH its `floor_plan` to point at B's
        floor plan instead of A's. Without a create-AND-update ownership
        check in ObjectSerializer.validate(), this would succeed --
        get_queryset()/get_object() only validate the *pre-update*
        floor_plan (A's own), and a plain writable PrimaryKeyRelatedField
        would otherwise happily accept any floor_plan PK that exists,
        regardless of who owns it.
        """
        self.login_as('user-a@example.com')

        response = self.client.patch(
            f'/api/objects/{self.object_a.id}/',
            {'floor_plan': self.floor_plan_b.id},
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 404)
        self.object_a.refresh_from_db()
        self.assertEqual(self.object_a.floor_plan_id, self.floor_plan_a.id)

    # -- Error path: nonexistent floor plan ------------------------------

    def test_nonexistent_floor_plan_returns_404(self):
        self.login_as('user-a@example.com')

        response = self.client.get('/api/floor-plans/999999/')

        self.assertEqual(response.status_code, 404)

    def test_object_create_with_nonexistent_floor_plan_returns_404_not_400(self):
        """Anti-enumeration guard (R14): a NONEXISTENT floor_plan reference
        must fail identically to a FOREIGN-owned one (404). With DRF's
        default unscoped PrimaryKeyRelatedField it would fail earlier with
        400 "Invalid pk", and the 400-vs-404 split becomes an oracle that
        enumerates which floor-plan IDs exist (see OwnedFloorPlanField).
        """
        self.login_as('user-b@example.com')

        response = self.client.post(
            '/api/objects/',
            {
                'floor_plan': 999999,
                'type': Objects.ObjectType.OUTLINES,
                'name': 'Probe',
                'x': 0,
                'y': 0,
            },
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 404)


class AccountsEndpointsRemainAnonymouslyAccessibleTests(TestCase):
    """Regression guard: flipping the global DRF default to IsAuthenticated
    must not break the accounts endpoints that are supposed to stay
    reachable without a session — they set their own AllowAny permission.
    This is a quick smoke test, not a re-test of accounts app behavior
    (already covered by backend/accounts/tests/).
    """

    def test_register_reachable_without_authentication(self):
        response = self.client.post(
            reverse('register'),
            {'email': 'newuser@example.com', 'password': VALID_PASSWORD},
            content_type='application/json',
        )

        self.assertNotIn(response.status_code, (401, 403))

    def test_login_reachable_without_authentication(self):
        make_verified_user()

        response = self.client.post(
            reverse('login'),
            {'email': 'verified@example.com', 'password': VALID_PASSWORD},
            content_type='application/json',
        )

        self.assertNotIn(response.status_code, (401, 403))

    def test_resend_verification_reachable_without_authentication(self):
        response = self.client.post(
            reverse('resend-verification'),
            {'email': 'someone@example.com'},
            content_type='application/json',
        )

        self.assertNotIn(response.status_code, (401, 403))

    def test_verify_email_reachable_without_authentication(self):
        response = self.client.get(reverse('verify-email', args=['bogus-token']))

        self.assertNotIn(response.status_code, (401, 403))

    def test_password_reset_reachable_without_authentication(self):
        response = self.client.post(
            reverse('password-reset'),
            {'email': 'someone@example.com'},
            content_type='application/json',
        )

        self.assertNotIn(response.status_code, (401, 403))
