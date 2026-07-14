import re

from django.core import mail
from django.test import Client, TestCase
from django.urls import reverse
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode

from accounts.models import User

VALID_PASSWORD = 'Correct-Horse-9427!'
NEW_PASSWORD = 'Totally-Different-8143!'


def make_verified_user(email='reset@example.com', password=VALID_PASSWORD):
    user = User.objects.create_user(email=email, password=password)
    user.is_active = True
    user.save()
    return user


def extract_uid_and_token(message_body):
    uid = re.search(r'^uid: (.+)$', message_body, re.MULTILINE).group(1)
    token = re.search(r'^token: (.+)$', message_body, re.MULTILINE).group(1)
    return uid, token


class PasswordResetRequestTests(TestCase):
    def test_request_for_existing_email_sends_email(self):
        make_verified_user()

        response = self.client.post(
            reverse('password-reset'),
            {'email': 'reset@example.com'},
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn('reset@example.com', mail.outbox[0].to)

    def test_request_for_nonexistent_email_returns_same_shape_and_status(self):
        make_verified_user()

        existing_response = self.client.post(
            reverse('password-reset'),
            {'email': 'reset@example.com'},
            content_type='application/json',
        )
        mail.outbox.clear()
        nonexistent_response = self.client.post(
            reverse('password-reset'),
            {'email': 'does-not-exist@example.com'},
            content_type='application/json',
        )

        self.assertEqual(existing_response.status_code, nonexistent_response.status_code)
        self.assertEqual(existing_response.json(), nonexistent_response.json())
        self.assertEqual(len(mail.outbox), 0)


class PasswordResetConfirmTests(TestCase):
    def setUp(self):
        self.user = make_verified_user()

    def _request_reset(self):
        self.client.post(
            reverse('password-reset'),
            {'email': 'reset@example.com'},
            content_type='application/json',
        )
        uid, token = extract_uid_and_token(mail.outbox[-1].body)
        return uid, token

    def test_full_reset_request_confirm_login_flow_works(self):
        uid, token = self._request_reset()

        confirm_response = self.client.post(
            reverse('password-reset-confirm'),
            {'uid': uid, 'token': token, 'new_password': NEW_PASSWORD},
            content_type='application/json',
        )
        self.assertEqual(confirm_response.status_code, 200)

        old_password_login = self.client.post(
            reverse('login'),
            {'email': 'reset@example.com', 'password': VALID_PASSWORD},
            content_type='application/json',
        )
        self.assertEqual(old_password_login.status_code, 400)

        new_password_login = self.client.post(
            reverse('login'),
            {'email': 'reset@example.com', 'password': NEW_PASSWORD},
            content_type='application/json',
        )
        self.assertEqual(new_password_login.status_code, 200)

    def test_invalid_token_is_rejected(self):
        uid = urlsafe_base64_encode(force_bytes(self.user.pk))

        response = self.client.post(
            reverse('password-reset-confirm'),
            {'uid': uid, 'token': 'not-a-real-token', 'new_password': NEW_PASSWORD},
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 400)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(VALID_PASSWORD))

    def test_expired_token_is_rejected(self):
        uid, token = self._request_reset()

        # Changing the password invalidates `PasswordResetTokenGenerator`
        # tokens (it hashes in the password), simulating "expired" without
        # relying on wall-clock time.
        self.user.set_password('some-other-password-01!')
        self.user.save()

        response = self.client.post(
            reverse('password-reset-confirm'),
            {'uid': uid, 'token': token, 'new_password': NEW_PASSWORD},
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 400)

    def test_weak_common_password_is_rejected(self):
        uid, token = self._request_reset()

        response = self.client.post(
            reverse('password-reset-confirm'),
            {'uid': uid, 'token': token, 'new_password': 'password'},
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn('new_password', response.json())
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(VALID_PASSWORD))

    def test_successful_reset_invalidates_previously_active_sessions(self):
        # Simulate a second device/attacker with an active session before
        # the reset.
        other_client = Client()
        login_response = other_client.post(
            reverse('login'),
            {'email': 'reset@example.com', 'password': VALID_PASSWORD},
            content_type='application/json',
        )
        self.assertEqual(login_response.status_code, 200)
        self.assertEqual(other_client.get(reverse('me')).status_code, 200)

        uid, token = self._request_reset()
        confirm_response = self.client.post(
            reverse('password-reset-confirm'),
            {'uid': uid, 'token': token, 'new_password': NEW_PASSWORD},
            content_type='application/json',
        )
        self.assertEqual(confirm_response.status_code, 200)

        # The second client's previously-valid session must no longer
        # authenticate.
        stale_session_response = other_client.get(reverse('me'))
        self.assertIn(stale_session_response.status_code, (401, 403))
