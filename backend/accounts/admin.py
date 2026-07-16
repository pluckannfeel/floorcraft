from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin
from django.contrib.auth.forms import UserChangeForm as DjangoUserChangeForm
from django.contrib.auth.forms import UserCreationForm as DjangoUserCreationForm

from .models import User


class UserCreationForm(DjangoUserCreationForm):
    """Bound to `accounts.User`, not the default `auth.User`.

    `DjangoUserCreationForm.Meta.fields` is `('username',)`, a field this
    model doesn't have (`username = None`) — without this override,
    `UserAdmin.get_form()` builds a form against the wrong model/fields and
    the "Add user" admin page raises `FieldError` before it ever renders.
    """

    class Meta(DjangoUserCreationForm.Meta):
        model = User
        fields = ('email',)


class UserChangeForm(DjangoUserChangeForm):
    """Bound to `accounts.User` — same rationale as `UserCreationForm`."""

    class Meta(DjangoUserChangeForm.Meta):
        model = User
        fields = '__all__'


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    add_form = UserCreationForm
    form = UserChangeForm
    ordering = ('email',)
    list_display = ('email', 'full_name', 'is_staff', 'is_active', 'date_joined')
    list_filter = ('is_staff', 'is_superuser', 'is_active')
    search_fields = ('email', 'full_name', 'contact_number', 'country', 'job_title')

    fieldsets = (
        (None, {'fields': ('email', 'password')}),
        (
            'Personal info',
            {'fields': ('full_name', 'contact_number', 'country', 'job_title')},
        ),
        (
            'Permissions',
            {
                'fields': (
                    'is_active',
                    'is_staff',
                    'is_superuser',
                    'groups',
                    'user_permissions',
                )
            },
        ),
        ('Important dates', {'fields': ('last_login', 'date_joined')}),
    )
    add_fieldsets = (
        (
            None,
            {
                'classes': ('wide',),
                'fields': (
                    'email',
                    'password1',
                    'password2',
                    'full_name',
                    'contact_number',
                    'country',
                    'job_title',
                ),
            },
        ),
    )
