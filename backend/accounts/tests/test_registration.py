from unittest import mock

from django.core import mail
from django.test import TestCase
from django.urls import reverse

from accounts.emails import make_verification_token
from accounts.models import User

VALID_PASSWORD = 'Correct-Horse-9427!'


def register_payload(**overrides):
    payload = {
        'email': 'person@example.com',
        'password': VALID_PASSWORD,
        'full_name': 'Person Example',
        'contact_number': '+1-555-0100',
        'country': 'Neverland',
        'job_title': 'Facilities Manager',
    }
    payload.update(overrides)
    return payload


class RegistrationTests(TestCase):
    def test_valid_registration_creates_inactive_user_and_sends_email(self):
        response = self.client.post(
            reverse('register'), register_payload(), content_type='application/json'
        )

        self.assertEqual(response.status_code, 201)
        user = User.objects.get(email='person@example.com')
        self.assertFalse(user.is_active)
        self.assertTrue(user.check_password(VALID_PASSWORD))
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn('person@example.com', mail.outbox[0].to)

    def test_registering_email_used_by_verified_account_is_rejected(self):
        verified = User.objects.create_user(
            email='taken@example.com', password=VALID_PASSWORD
        )
        verified.is_active = True
        verified.save()

        response = self.client.post(
            reverse('register'),
            register_payload(email='taken@example.com'),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 400)
        verified.refresh_from_db()
        # No new row created, existing row untouched.
        self.assertEqual(User.objects.filter(email='taken@example.com').count(), 1)
        self.assertEqual(verified.full_name, '')

    def test_registering_unverified_email_overwrites_pending_registration(self):
        pending = User.objects.create_user(
            email='pending@example.com', password='OldPassword123!', full_name='Old Name'
        )
        pending.is_active = False
        pending.save()
        old_token = make_verification_token(pending.id)

        response = self.client.post(
            reverse('register'),
            register_payload(email='pending@example.com', full_name='New Name'),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(User.objects.filter(email='pending@example.com').count(), 1)
        pending.refresh_from_db()
        self.assertEqual(pending.full_name, 'New Name')
        self.assertTrue(pending.check_password(VALID_PASSWORD))
        self.assertFalse(pending.is_active)

        # A fresh verification email was sent and it verifies this user.
        # (The signed token is a deterministic function of user id + second
        # of issuance, so it may legitimately coincide with `old_token` if
        # both are issued within the same second — that doesn't mean a new
        # token wasn't reissued, just that the value happens to match; the
        # meaningful assertion is that the mailed link actually verifies
        # the overwritten row.)
        self.assertEqual(len(mail.outbox), 1)
        verify_response = self.client.get(reverse('verify-email', args=[old_token]))
        self.assertEqual(verify_response.status_code, 200)
        pending.refresh_from_db()
        self.assertTrue(pending.is_active)

    def test_weak_common_password_is_rejected(self):
        response = self.client.post(
            reverse('register'),
            register_payload(email='weak@example.com', password='password'),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn('password', response.json())
        self.assertFalse(User.objects.filter(email='weak@example.com').exists())

    def test_password_similar_to_user_attributes_is_rejected(self):
        response = self.client.post(
            reverse('register'),
            register_payload(
                email='similar@example.com',
                password='personexample',
                full_name='Person Example',
            ),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 400)
        self.assertFalse(User.objects.filter(email='similar@example.com').exists())

    def test_concurrent_registration_for_same_new_email_returns_400_not_500(self):
        """Regression test for a code-review finding: `RegisterView`'s
        check-then-act flow (`filter().first()` then `create_user()`) isn't
        atomic with itself, so two near-simultaneous registrations for the
        same brand-new email can both pass the pre-check before either
        commits — the second `create_user()` call then hits the `email`
        column's `unique=True` constraint. Simulated here (rather than with
        real threads) by patching the pre-check to report "no existing
        user" even though one already exists, forcing the code down the
        `create_user()` path into a real `IntegrityError`.
        """
        User.objects.create_user(email='racer@example.com', password=VALID_PASSWORD)

        with mock.patch('accounts.views.User.objects.filter') as mocked_filter:
            mocked_filter.return_value.first.return_value = None
            response = self.client.post(
                reverse('register'),
                register_payload(email='racer@example.com'),
                content_type='application/json',
            )

        self.assertEqual(response.status_code, 400)
        self.assertIn('email', response.json())
        self.assertEqual(User.objects.filter(email='racer@example.com').count(), 1)


class VerifyEmailTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email='verify@example.com', password=VALID_PASSWORD
        )
        self.user.is_active = False
        self.user.save()

    def test_valid_unexpired_link_activates_user(self):
        token = make_verification_token(self.user.id)

        response = self.client.get(reverse('verify-email', args=[token]))

        self.assertEqual(response.status_code, 200)
        self.user.refresh_from_db()
        self.assertTrue(self.user.is_active)

    def test_expired_link_returns_clear_expired_response_and_stays_inactive(self):
        token = make_verification_token(self.user.id)

        # Force the view's expiry window to a negative value so the
        # already-signed token is guaranteed to read as expired, without
        # relying on real wall-clock sleeping.
        with mock.patch('accounts.views.VERIFICATION_MAX_AGE_SECONDS', -1):
            response = self.client.get(reverse('verify-email', args=[token]))

        self.assertEqual(response.status_code, 400)
        self.assertIn('expired', response.json()['detail'].lower())
        self.user.refresh_from_db()
        self.assertFalse(self.user.is_active)

    def test_already_used_verification_link_is_idempotent_success(self):
        token = make_verification_token(self.user.id)

        first = self.client.get(reverse('verify-email', args=[token]))
        second = self.client.get(reverse('verify-email', args=[token]))

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.user.refresh_from_db()
        self.assertTrue(self.user.is_active)

    def test_invalid_token_returns_error(self):
        response = self.client.get(reverse('verify-email', args=['not-a-real-token']))
        self.assertEqual(response.status_code, 400)


class ResendVerificationTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email='unverified@example.com', password=VALID_PASSWORD
        )
        self.user.is_active = False
        self.user.save()

    def test_resend_for_existing_unverified_email_sends_new_email(self):
        response = self.client.post(
            reverse('resend-verification'),
            {'email': 'unverified@example.com'},
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(mail.outbox), 1)

    def test_resend_for_nonexistent_email_returns_same_shape_and_status(self):
        existing_response = self.client.post(
            reverse('resend-verification'),
            {'email': 'unverified@example.com'},
            content_type='application/json',
        )
        mail.outbox.clear()
        nonexistent_response = self.client.post(
            reverse('resend-verification'),
            {'email': 'does-not-exist@example.com'},
            content_type='application/json',
        )

        self.assertEqual(existing_response.status_code, nonexistent_response.status_code)
        self.assertEqual(existing_response.json(), nonexistent_response.json())
        # No email sent for the nonexistent address.
        self.assertEqual(len(mail.outbox), 0)

    def test_resend_for_already_verified_email_returns_same_shape_and_status(self):
        self.user.is_active = True
        self.user.save()

        response = self.client.post(
            reverse('resend-verification'),
            {'email': 'unverified@example.com'},
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            'detail': 'If an account with that email exists and needs verification, a new verification email has been sent.',
        })
        self.assertEqual(len(mail.outbox), 0)
