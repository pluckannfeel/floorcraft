from django.test import Client, TestCase
from django.urls import reverse

from accounts.models import User

VALID_PASSWORD = 'Correct-Horse-9427!'


def make_verified_user(email='verified@example.com', password=VALID_PASSWORD):
    user = User.objects.create_user(email=email, password=password)
    user.is_active = True
    user.save()
    return user


def make_unverified_user(email='unverified@example.com', password=VALID_PASSWORD):
    user = User.objects.create_user(email=email, password=password)
    user.is_active = False
    user.save()
    return user


class LoginTests(TestCase):
    def test_valid_credentials_for_verified_user_establish_session(self):
        make_verified_user()

        response = self.client.post(
            reverse('login'),
            {'email': 'verified@example.com', 'password': VALID_PASSWORD},
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['email'], 'verified@example.com')

        # Session actually established: a subsequent authenticated request
        # succeeds without re-authenticating.
        me_response = self.client.get(reverse('me'))
        self.assertEqual(me_response.status_code, 200)
        self.assertEqual(me_response.json()['email'], 'verified@example.com')

    def test_unverified_user_rejected_with_same_shape_as_wrong_password(self):
        make_unverified_user()
        make_verified_user(email='other@example.com')

        unverified_response = self.client.post(
            reverse('login'),
            {'email': 'unverified@example.com', 'password': VALID_PASSWORD},
            content_type='application/json',
        )
        wrong_password_response = self.client.post(
            reverse('login'),
            {'email': 'other@example.com', 'password': 'totally-wrong'},
            content_type='application/json',
        )

        self.assertEqual(unverified_response.status_code, 400)
        self.assertEqual(wrong_password_response.status_code, 400)
        self.assertEqual(unverified_response.json(), wrong_password_response.json())

    def test_wrong_password_rejected(self):
        make_verified_user()

        response = self.client.post(
            reverse('login'),
            {'email': 'verified@example.com', 'password': 'wrong-password'},
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 400)

    def test_login_without_primed_csrf_cookie_or_header_returns_403(self):
        """Regression guard: CSRF protection on the AllowAny login endpoint
        must stay enforced by `CsrfViewMiddleware`. Uses
        `enforce_csrf_checks=True` since Django's default test client
        patches CSRF checks out entirely.
        """
        make_verified_user()
        csrf_client = Client(enforce_csrf_checks=True)

        response = csrf_client.post(
            reverse('login'),
            {'email': 'verified@example.com', 'password': VALID_PASSWORD},
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 403)

    def test_login_with_primed_csrf_cookie_and_header_succeeds(self):
        make_verified_user()
        csrf_client = Client(enforce_csrf_checks=True)

        csrf_response = csrf_client.get(reverse('csrf'))
        self.assertIn('csrftoken', csrf_response.cookies)
        csrf_token = csrf_response.cookies['csrftoken'].value

        response = csrf_client.post(
            reverse('login'),
            {'email': 'verified@example.com', 'password': VALID_PASSWORD},
            content_type='application/json',
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        self.assertEqual(response.status_code, 200)


class LogoutTests(TestCase):
    def test_logout_ends_session_and_subsequent_request_is_rejected(self):
        make_verified_user()
        self.client.post(
            reverse('login'),
            {'email': 'verified@example.com', 'password': VALID_PASSWORD},
            content_type='application/json',
        )
        self.assertEqual(self.client.get(reverse('me')).status_code, 200)

        logout_response = self.client.post(reverse('logout'))
        self.assertEqual(logout_response.status_code, 204)

        me_response = self.client.get(reverse('me'))
        self.assertIn(me_response.status_code, (401, 403))

    def test_logout_requires_authentication(self):
        response = self.client.post(reverse('logout'))
        self.assertIn(response.status_code, (401, 403))


class MeTests(TestCase):
    def test_me_returns_user_info_when_authenticated(self):
        user = make_verified_user()
        self.client.post(
            reverse('login'),
            {'email': 'verified@example.com', 'password': VALID_PASSWORD},
            content_type='application/json',
        )

        response = self.client.get(reverse('me'))

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body['id'], user.id)
        self.assertEqual(body['email'], 'verified@example.com')

    def test_me_returns_401_or_403_when_not_authenticated(self):
        response = self.client.get(reverse('me'))
        self.assertIn(response.status_code, (401, 403))


class CsrfViewTests(TestCase):
    def test_csrf_view_primes_cookie(self):
        response = self.client.get(reverse('csrf'))
        self.assertIn(response.status_code, (200, 204))
        self.assertIn('csrftoken', response.cookies)
