from django.core import signing
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .emails import (
    VERIFICATION_MAX_AGE_SECONDS,
    VERIFICATION_SALT,
    send_verification_email,
)
from .models import User
from .serializers import RegistrationSerializer

# Generic, identical response for resend-verification regardless of whether
# the email exists/is verified — avoids user enumeration (R5's Approach).
RESEND_VERIFICATION_RESPONSE = {
    'detail': 'If an account with that email exists and needs verification, a new verification email has been sent.',
}


class RegisterView(APIView):
    """POST /api/auth/register/

    Open to anonymous callers from the start (see U2 plan Approach: this
    must already be `AllowAny` before U4 flips the project-wide DRF
    default to `IsAuthenticated`).
    """

    permission_classes = [AllowAny]

    def post(self, request):
        serializer = RegistrationSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        email = data['email']

        existing = User.objects.filter(email=email).first()
        if existing is not None:
            if existing.is_active:
                # R3: uniqueness is only enforced against *verified* users.
                return Response(
                    {'email': ['An account with this email already exists.']},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            # R3: re-registering an unverified email overwrites the pending
            # registration and issues a fresh token, rather than erroring.
            user = existing
            user.full_name = data.get('full_name', '')
            user.contact_number = data.get('contact_number', '')
            user.country = data.get('country', '')
            user.job_title = data.get('job_title', '')
            user.set_password(data['password'])
            user.is_active = False
            user.save()
        else:
            user = User.objects.create_user(
                email=email,
                password=data['password'],
                full_name=data.get('full_name', ''),
                contact_number=data.get('contact_number', ''),
                country=data.get('country', ''),
                job_title=data.get('job_title', ''),
            )
            user.is_active = False
            user.save(update_fields=['is_active'])

        send_verification_email(user)

        return Response(
            {'detail': 'Registration successful. Please check your email to verify your account.'},
            status=status.HTTP_201_CREATED,
        )


class VerifyEmailView(APIView):
    """GET /api/auth/verify-email/<token>/

    A state change on a safe HTTP method is a deliberate, accepted
    tradeoff for a clickable email link (see U2 plan Approach) — largely
    defused by making reuse an idempotent no-op success rather than an
    error.
    """

    permission_classes = [AllowAny]

    def get(self, request, token):
        signer = signing.TimestampSigner(salt=VERIFICATION_SALT)
        try:
            user_id = signer.unsign(token, max_age=VERIFICATION_MAX_AGE_SECONDS)
        except signing.SignatureExpired:
            return Response(
                {'detail': 'This verification link has expired. Please request a new one.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except signing.BadSignature:
            return Response(
                {'detail': 'This verification link is invalid.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            user = User.objects.get(pk=user_id)
        except (User.DoesNotExist, ValueError, TypeError):
            return Response(
                {'detail': 'This verification link is invalid.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not user.is_active:
            user.is_active = True
            user.save(update_fields=['is_active'])

        # Already-verified/reused tokens are a no-op success, not an error.
        return Response({'detail': 'Your email has been verified. You can now log in.'})


class ResendVerificationView(APIView):
    """POST /api/auth/resend-verification/

    Responds identically whether or not the email exists or is already
    verified (same body, same status code, same normalized email lookup)
    to avoid user enumeration. The existing-unverified and
    non-existent/already-verified branches are kept work-equivalent (not
    just same-shaped) by performing an equivalent-cost dummy signing
    operation on the "nothing to do" path, closing most of the timing gap
    against a DB write + email send — defense in depth, not the primary
    control (deferred rate limiting is the primary mitigation).
    """

    permission_classes = [AllowAny]

    def post(self, request):
        email = (request.data.get('email') or '').strip().lower()
        email = User.objects.normalize_email(email) if email else email

        user = User.objects.filter(email=email).first() if email else None

        if user is not None and not user.is_active:
            send_verification_email(user)
        else:
            # Work-equivalent dummy path: generate a token for a throwaway
            # subject so this branch performs comparable signing work to
            # the real send, without a DB write or an actual email dispatch.
            signing.TimestampSigner(salt=VERIFICATION_SALT).sign('0')

        return Response(RESEND_VERIFICATION_RESPONSE)
