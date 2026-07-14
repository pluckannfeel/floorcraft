from django.test import TestCase

from accounts.models import User


class UserManagerTests(TestCase):
    """Happy path: creating a user via UserManager.create_user produces a
    hashed password; edge case: no email raises ValueError; happy path:
    create_superuser produces is_staff/is_superuser True.
    """

    def test_create_user_hashes_password(self):
        user = User.objects.create_user(
            email='person@example.com',
            password='S0meStrongPass!',
            full_name='Person Example',
        )

        self.assertEqual(user.email, 'person@example.com')
        self.assertEqual(user.full_name, 'Person Example')
        self.assertNotEqual(user.password, 'S0meStrongPass!')
        self.assertTrue(user.check_password('S0meStrongPass!'))
        self.assertFalse(user.is_staff)
        self.assertFalse(user.is_superuser)

    def test_create_user_without_email_raises(self):
        with self.assertRaises(ValueError):
            User.objects.create_user(email='', password='S0meStrongPass!')

    def test_create_superuser_sets_staff_and_superuser_flags(self):
        superuser = User.objects.create_superuser(
            email='admin@example.com',
            password='S0meStrongPass!',
        )

        self.assertTrue(superuser.is_staff)
        self.assertTrue(superuser.is_superuser)
        self.assertTrue(superuser.check_password('S0meStrongPass!'))
