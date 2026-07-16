from django.urls import path

from . import views

urlpatterns = [
    path('register/', views.RegisterView.as_view(), name='register'),
    path('verify-email/<str:token>/', views.VerifyEmailView.as_view(), name='verify-email'),
    path('resend-verification/', views.ResendVerificationView.as_view(), name='resend-verification'),
    path('csrf/', views.CsrfView.as_view(), name='csrf'),
    path('login/', views.LoginView.as_view(), name='login'),
    path('logout/', views.LogoutView.as_view(), name='logout'),
    path('me/', views.MeView.as_view(), name='me'),
    path('password-reset/', views.PasswordResetRequestView.as_view(), name='password-reset'),
    path(
        'password-reset-confirm/',
        views.PasswordResetConfirmView.as_view(),
        name='password-reset-confirm',
    ),
]
