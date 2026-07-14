from django.contrib.auth import password_validation
from rest_framework import serializers

from .models import User


class RegistrationSerializer(serializers.ModelSerializer):
    """Registration input. Plain `ModelSerializer` style, matching
    `fm_generator.serializers`.

    Password strength is enforced explicitly in `validate()` via Django's
    `validate_password()` against `AUTH_PASSWORD_VALIDATORS` — DRF/Django
    never call this automatically, and `UserAttributeSimilarityValidator`
    specifically needs the in-memory (unsaved) `User` instance passed as
    its `user=` argument to compare the password against user attributes;
    without that instance it silently no-ops.
    """

    # Plain `EmailField` (not the model-derived one) so DRF does not attach
    # its automatic `UniqueValidator` for the model's `unique=True` email
    # column: uniqueness here is intentionally *not* a flat DB-uniqueness
    # check (R3) — the view decides whether a colliding row blocks
    # registration (verified) or gets overwritten (unverified), and a
    # blanket `UniqueValidator` would reject the overwrite case outright
    # before that logic ever runs.
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, style={'input_type': 'password'})

    class Meta:
        model = User
        fields = [
            'email', 'password', 'full_name', 'contact_number',
            'country', 'job_title',
        ]

    def validate_email(self, value):
        return User.objects.normalize_email(value).strip().lower()

    def validate(self, attrs):
        password = attrs.get('password')
        candidate_user = User(
            email=attrs.get('email', ''),
            full_name=attrs.get('full_name', ''),
            contact_number=attrs.get('contact_number', ''),
            country=attrs.get('country', ''),
            job_title=attrs.get('job_title', ''),
        )
        try:
            password_validation.validate_password(password, user=candidate_user)
        except serializers.ValidationError:
            raise
        except Exception as exc:  # django.core.exceptions.ValidationError
            raise serializers.ValidationError({'password': list(exc.messages)})
        return attrs


class LoginSerializer(serializers.Serializer):
    """Login input. Deliberately does not touch the DB or call
    `authenticate()` itself — the view does that, since `ModelBackend`'s
    `is_active` check must be the single source of truth for "can this
    user log in" (see U3 plan Approach: no separate hand-rolled
    `is_active` check, to avoid a timing/enumeration side channel).
    """

    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, style={'input_type': 'password'})


class MeSerializer(serializers.ModelSerializer):
    """Current-user info returned by `GET /api/auth/me/`."""

    class Meta:
        model = User
        fields = [
            'id', 'email', 'full_name', 'contact_number', 'country', 'job_title',
        ]


class PasswordResetRequestSerializer(serializers.Serializer):
    email = serializers.EmailField()


class PasswordResetConfirmSerializer(serializers.Serializer):
    """`password-reset-confirm` input. Password strength is validated in
    `validate()`, same pattern as `RegistrationSerializer`, but against the
    *existing* user instance resolved by the view (passed in via
    `set_user_context`) rather than an in-memory candidate — the user
    already exists here, unlike at registration.
    """

    uid = serializers.CharField()
    token = serializers.CharField()
    new_password = serializers.CharField(write_only=True, style={'input_type': 'password'})

    def set_user_context(self, user):
        self._user = user

    def validate(self, attrs):
        user = getattr(self, '_user', None)
        if user is not None:
            password = attrs.get('new_password')
            try:
                password_validation.validate_password(password, user=user)
            except serializers.ValidationError:
                raise
            except Exception as exc:  # django.core.exceptions.ValidationError
                raise serializers.ValidationError({'new_password': list(exc.messages)})
        return attrs
