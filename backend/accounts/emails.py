from django.conf import settings
from django.core.mail import send_mail
from django.core.signing import TimestampSigner

VERIFICATION_SALT = 'accounts.email-verification'

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
