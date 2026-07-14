from django.conf import settings
from django.contrib.auth.tokens import PasswordResetTokenGenerator
from django.core.mail import send_mail
from django.core.signing import TimestampSigner
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode

VERIFICATION_SALT = 'accounts.email-verification'

# Django's built-in token generator (also used to invalidate a user's
# password-reset tokens automatically once their password/last_login
# changes, since it's derived from those fields).
password_reset_token_generator = PasswordResetTokenGenerator()

# Kept in sync with the `max_age` passed to `TimestampSigner.unsign` in
# `views.py` when validating the token.
VERIFICATION_MAX_AGE_SECONDS = 60 * 60 * 24  # 24 hours


def make_verification_token(user_id):
    """Sign a stateless, expiring email-verification token embedding the
    user's id. Validity is enforced by `TimestampSigner.unsign(max_age=...)`
    at verification time, not anything stored on the user row.
    """
    signer = TimestampSigner(salt=VERIFICATION_SALT)
    return signer.sign(str(user_id))


def send_verification_email(user):
    """Send (or, in local dev, console-print) a verification email
    containing a signed, time-limited verification link for `user`.
    """
    token = make_verification_token(user.id)
    verify_path = f'/api/auth/verify-email/{token}/'
    verify_url = f'{settings.SITE_URL}{verify_path}'

    send_mail(
        subject='Verify your FloorCraft account',
        message=(
            f'Hi {user.full_name or user.email},\n\n'
            'Please verify your email address by visiting the link below. '
            'This link expires in 24 hours.\n\n'
            f'{verify_url}\n\n'
            "If you didn't request this, you can safely ignore this email."
        ),
        from_email=settings.DEFAULT_FROM_EMAIL,
        recipient_list=[user.email],
        fail_silently=False,
    )
    return token


def send_password_reset_email(user):
    """Send (or, in local dev, console-print) a password-reset email
    containing a link built from Django's built-in
    `PasswordResetTokenGenerator` plus a base64-encoded uid — the standard
    Django `PasswordResetForm`/`auth_views` pattern, reused here since
    this app hand-rolls the view but not the token/uid scheme.
    """
    uid = urlsafe_base64_encode(force_bytes(user.pk))
    token = password_reset_token_generator.make_token(user)
    reset_path = f'/reset-password/{uid}/{token}/'
    reset_url = f'{settings.SITE_URL}{reset_path}'

    send_mail(
        subject='Reset your FloorCraft password',
        message=(
            f'Hi {user.full_name or user.email},\n\n'
            'You (or someone else) requested a password reset for your '
            'FloorCraft account. Visit the link below to choose a new '
            'password. If you did not request this, you can safely '
            'ignore this email.\n\n'
            f'{reset_url}\n\n'
            f'uid: {uid}\n'
            f'token: {token}\n'
        ),
        from_email=settings.DEFAULT_FROM_EMAIL,
        recipient_list=[user.email],
        fail_silently=False,
    )
    return uid, token
