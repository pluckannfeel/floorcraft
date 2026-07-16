from django.contrib.admin.sites import site
from django.test import RequestFactory, TestCase

from accounts.models import User


class UserAdminFormTests(TestCase):
    """Regression coverage for a code-review finding: `UserAdmin` did not
    override `add_form`/`form`, so Django's `UserAdmin.get_form()` fell back
    to the inherited `UserCreationForm`/`UserChangeForm` bound to the
    default `auth.User` (which still references the removed `username`
    field) — building the "Add user" admin form raised `FieldError` before
    the page ever rendered.
    """

    @classmethod
    def setUpTestData(cls):
        cls.superuser = User.objects.create_superuser(
            email='admin@example.com', password='S0meStrongPass!',
        )

    def _request(self):
        request = RequestFactory().get('/admin/accounts/user/add/')
        request.user = self.superuser
        return request

    def test_add_form_builds_without_error(self):
        model_admin = site._registry[User]

        form_class = model_admin.get_form(self._request(), obj=None)
        form = form_class()

        self.assertIn('email', form.fields)
        self.assertNotIn('username', form.fields)

    def test_change_form_builds_without_error(self):
        user = User.objects.create_user(email='person@example.com', password='S0meStrongPass!')
        model_admin = site._registry[User]

        form_class = model_admin.get_form(self._request(), obj=user)
        form = form_class(instance=user)

        self.assertIn('email', form.fields)
        self.assertNotIn('username', form.fields)
