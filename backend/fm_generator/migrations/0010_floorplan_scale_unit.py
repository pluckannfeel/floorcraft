# Written by hand to match `makemigrations fm_generator --name
# floorplan_scale_unit` output exactly (the container's bind mount is not
# writable by the app user, so the generated file couldn't land on disk —
# same situation as 0007/0008/0009; the autodetector's plan was verified
# with `makemigrations --check --dry-run` to be these two AddField ops for
# U1's canvas-rulers-scale per-plan settings). Both adds carry a default,
# so they backfill pre-existing FloorPlan rows automatically (R3/AE3) and
# need no `atomic=False` / RunPython backfill.

import django.core.validators
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('fm_generator', '0009_objectvariant'),
    ]

    operations = [
        migrations.AddField(
            model_name='floorplan',
            name='real_size_per_grid_square',
            field=models.FloatField(
                default=0.5,
                validators=[django.core.validators.MinValueValidator(0.0001)],
            ),
        ),
        migrations.AddField(
            model_name='floorplan',
            name='unit',
            field=models.CharField(
                choices=[('meters', 'Meters'), ('feet_inches', 'Feet & inches')],
                default='meters',
                max_length=12,
            ),
        ),
    ]
