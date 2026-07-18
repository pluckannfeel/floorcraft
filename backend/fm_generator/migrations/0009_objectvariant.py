# Written by hand to match `makemigrations fm_generator --name
# objectvariant` output exactly (the container's bind mount is not
# writable by the app user, so the generated file couldn't land on disk —
# same situation as 0007/0008; the autodetector's plan was verified with
# `makemigrations --check --dry-run` to be this single CreateModel for
# U1's ObjectVariant: per-user uploaded visuals for the 7 catalog types,
# with the soft-delete flag that is the R11 mechanism).

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import fm_generator.models


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('fm_generator', '0008_objects_type_text'),
    ]

    operations = [
        migrations.CreateModel(
            name='ObjectVariant',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('object_type', models.CharField(
                    choices=[
                        ('outlines', 'Outlines'),
                        ('tables', 'Tables'),
                        ('doors', 'Doors'),
                        ('chairs', 'Chairs'),
                        ('furnitures', 'Furnitures'),
                        ('appliances', 'Appliances'),
                        ('lighting', 'Lighting'),
                    ],
                    max_length=20,
                )),
                ('file', models.FileField(max_length=255, upload_to=fm_generator.models.variant_upload_to)),
                ('kind', models.CharField(choices=[('svg', 'SVG'), ('png', 'PNG'), ('jpeg', 'JPEG')], max_length=4)),
                ('width', models.PositiveIntegerField()),
                ('height', models.PositiveIntegerField()),
                ('size_bytes', models.PositiveBigIntegerField()),
                ('original_name', models.CharField(max_length=255)),
                ('is_active', models.BooleanField(default=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('owner', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='object_variants', to=settings.AUTH_USER_MODEL)),
            ],
        ),
    ]
