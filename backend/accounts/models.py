from django.contrib.auth.models import AbstractUser
from django.db import models

from .managers import UserManager


class User(AbstractUser):
    """Email-based custom user model.

    Swaps `AbstractUser`'s default `username` login field for `email`,
    since this app has no product need for a separate username.
    """

    username = None
    email = models.EmailField(unique=True)

    full_name = models.CharField(max_length=255, blank=True)
    contact_number = models.CharField(max_length=32, blank=True)
    country = models.CharField(max_length=128, blank=True)
    job_title = models.CharField(max_length=128, blank=True)

    USERNAME_FIELD = 'email'
    REQUIRED_FIELDS = []

    objects = UserManager()

    def __str__(self):
        return self.email


def normalize_email(raw_email):
    """Trim, lowercase, and apply Django's domain-part normalization.

    Shared by every place that looks up or stores an email address for
    lookup purposes (registration, resend-verification,
    password-reset-request) so the normalization rule can't drift between
    them.
    """
    email = (raw_email or '').strip().lower()
    return User.objects.normalize_email(email) if email else email
