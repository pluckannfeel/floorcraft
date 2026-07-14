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
        self.floor_plan = FloorPlan.objects.create(name='Test Floor Plan')
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
