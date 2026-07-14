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
