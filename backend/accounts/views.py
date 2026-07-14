from django.contrib.auth import authenticate, login as django_login, logout as django_logout
from django.contrib.sessions.models import Session
from django.core import signing
from django.utils import timezone
from django.utils.encoding import force_str
from django.utils.http import urlsafe_base64_decode
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from django.utils.decorators import method_decorator
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .emails import (
    VERIFICATION_MAX_AGE_SECONDS,
    VERIFICATION_SALT,
    password_reset_token_generator,
    send_password_reset_email,
    send_verification_email,
)
from .models import User
from .serializers import (
    LoginSerializer,
    MeSerializer,
    PasswordResetConfirmSerializer,
    PasswordResetRequestSerializer,
    RegistrationSerializer,
)

# Generic, identical response for resend-verification regardless of whether
# the email exists/is verified — avoids user enumeration (R5's Approach).
RESEND_VERIFICATION_RESPONSE = {
    'detail': 'If an account with that email exists and needs verification, a new verification email has been sent.',
}

# Same non-enumeration pattern as resend-verification (U3 plan Approach):
# identical body/status/normalized-lookup regardless of whether the email
# exists.
PASSWORD_RESET_REQUEST_RESPONSE = {
    'detail': 'If an account with that email exists, a password reset email has been sent.',
}

# Generic error for login — never distinguishes "no such user" from "wrong
# password" from "unverified account" (ModelBackend's built-in is_active
# check already refuses inactive users; a distinct message for that case
# would reopen the exact enumeration side channel that check exists to
# close). See U3 plan Approach.
INVALID_LOGIN_RESPONSE = {'detail': 'Unable to log in with the provided credentials.'}

# NOTE ON CSRF (see U3 plan Approach): `CsrfViewMiddleware` must stay
# present in `MIDDLEWARE` (see core/settings.py) and must not be
# reordered relative to `SessionMiddleware`/`AuthenticationMiddleware` —
# but that alone is NOT sufficient for these views. DRF's
# `APIView.as_view()` unconditionally marks every DRF view
# `csrf_exempt`, deferring CSRF enforcement to
# `SessionAuthentication.enforce_csrf()` — which only runs once a
# session-authenticated user has already been resolved *from* the
# session. For an anonymous request that is itself establishing the
# session (login) or otherwise mutating state without ever
# authenticating (register, resend-verification, password-reset*),
# `enforce_csrf()` never fires, so those requests would otherwise sail
# through with NO CSRF protection at all despite `CsrfViewMiddleware`
# being installed. The views below explicitly re-enable Django's CSRF
# check via `@method_decorator(csrf_protect, name='dispatch')`, which
# invokes `CsrfViewMiddleware`'s check directly rather than relying on
# the (here, defeated) exemption flag. Do not remove this decorator from
# any AllowAny state-changing view, and do not "fix" a CSRF failure
# encountered during development by adding `@csrf_exempt`.


@method_decorator(csrf_protect, name='dispatch')
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


@method_decorator(csrf_protect, name='dispatch')
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


@method_decorator(ensure_csrf_cookie, name='get')
class CsrfView(APIView):
    """GET /api/auth/csrf/

    Open to anonymous callers (see U3 plan Approach — must already be
    `AllowAny` before U4 flips the project-wide DRF default). Its only job
    is to prime the CSRF cookie via `@ensure_csrf_cookie`: Django only sets
    the cookie on a response when something in the request cycle asks it
    to, and the frontend needs it primed before its first unsafe (POST)
    request such as login/register.
    """

    permission_classes = [AllowAny]

    def get(self, request):
        return Response(status=status.HTTP_204_NO_CONTENT)


@method_decorator(csrf_protect, name='dispatch')
class LoginView(APIView):
    """POST /api/auth/login/

    Open to anonymous callers from the start (same rationale as
    `RegisterView`/`CsrfView`). Relies entirely on `authenticate()` /
    `ModelBackend`'s built-in `is_active` check to refuse unverified
    users — deliberately does NOT hand-check `user.is_active` separately
    with a different error message, since doing so would reintroduce a
    timing/enumeration side channel that lets a caller distinguish
    "wrong password" from "unverified account" (see U3 plan Approach).
    """

    permission_classes = [AllowAny]

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data['email']
        password = serializer.validated_data['password']

        user = authenticate(request, username=email, password=password)
        if user is None:
            return Response(INVALID_LOGIN_RESPONSE, status=status.HTTP_400_BAD_REQUEST)

        django_login(request, user)
        return Response(MeSerializer(user).data)


class LogoutView(APIView):
    """POST /api/auth/logout/ (R29)"""

    permission_classes = [IsAuthenticated]

    def post(self, request):
        django_logout(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class MeView(APIView):
    """GET /api/auth/me/

    Called by the frontend's `AuthContext` on app boot to determine
    session validity (U3 plan Approach) — returns the current user's
    basic info when authenticated, or 401/403 (via DRF's default
    `IsAuthenticated` handling) otherwise.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(MeSerializer(request.user).data)


def _invalidate_all_sessions_for_user(user):
    """Delete every non-expired `Session` row whose decoded
    `_auth_user_id` matches `user`.

    `password-reset-confirm` is an anonymous/`AllowAny` endpoint — there is
    no "current session" performing the reset to preserve, unlike an
    authenticated change-password flow, so ALL of the user's active
    sessions are invalidated, not "other than the current one" (see U3
    plan Approach).
    """
    user_id = str(user.pk)
    sessions = Session.objects.filter(expire_date__gte=timezone.now())
    for session in sessions:
        data = session.get_decoded()
        if str(data.get('_auth_user_id')) == user_id:
            session.delete()


@method_decorator(csrf_protect, name='dispatch')
class PasswordResetRequestView(APIView):
    """POST /api/auth/password-reset/

    Same non-enumeration response shape as `ResendVerificationView` (same
    body, status code, and normalized email lookup) — see U3 plan
    Approach.
    """

    permission_classes = [AllowAny]

    def post(self, request):
        serializer = PasswordResetRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = User.objects.normalize_email(serializer.validated_data['email'].strip().lower())

        user = User.objects.filter(email=email, is_active=True).first()

        if user is not None:
            send_password_reset_email(user)
        else:
            # Work-equivalent dummy path, same rationale as
            # `ResendVerificationView`.
            password_reset_token_generator.make_token(
                User(pk=0, password='!', last_login=None)
            )

        return Response(PASSWORD_RESET_REQUEST_RESPONSE)


@method_decorator(csrf_protect, name='dispatch')
class PasswordResetConfirmView(APIView):
    """POST /api/auth/password-reset-confirm/

    Validates the `PasswordResetTokenGenerator` token, calls
    `validate_password()` on the new password against the real user
    instance (same pattern as registration — see U2), sets the new
    password, and invalidates the user's other active sessions.
    """

    permission_classes = [AllowAny]

    def post(self, request):
        uid = request.data.get('uid')
        token = request.data.get('token') or ''

        try:
            user_id = force_str(urlsafe_base64_decode(uid))
            user = User.objects.get(pk=user_id)
        except (TypeError, ValueError, OverflowError, User.DoesNotExist):
            user = None

        if user is None or not password_reset_token_generator.check_token(user, token):
            return Response(
                {'detail': 'This password reset link is invalid or has expired.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        serializer = PasswordResetConfirmSerializer(data=request.data)
        serializer.set_user_context(user)
        serializer.is_valid(raise_exception=True)

        user.set_password(serializer.validated_data['new_password'])
        user.save(update_fields=['password'])

        # Lock out anyone (attacker or otherwise) holding an active
        # session for this account before the reset.
        _invalidate_all_sessions_for_user(user)

        return Response({'detail': 'Your password has been reset. You can now log in.'})
