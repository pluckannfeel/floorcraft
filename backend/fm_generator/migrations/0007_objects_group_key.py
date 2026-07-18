# Written by hand to match `makemigrations fm_generator --name
# objects_group_key` output exactly (the container's bind mount is not
# writable by the app user, so the generated file couldn't land on disk —
# the autodetector's plan was verified to be this single AddField).

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('fm_generator', '0006_add_floorplan_owner'),
    ]

    operations = [
        migrations.AddField(
            model_name='objects',
            name='group_key',
            field=models.CharField(blank=True, db_index=True, max_length=64, null=True),
        ),
    ]
