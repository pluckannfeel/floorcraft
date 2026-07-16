import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


def delete_all_floor_plans(apps, schema_editor):
    """Delete all existing FloorPlan rows (cascading to their Objects rows
    via the existing FK) before `owner` is added as a non-nullable field.
    This dev-only fixture data (including the legacy hardcoded floor plan
    with id 1) predates FloorPlan having an ownership concept, so there is
    no real user to backfill it onto -- reset, not backfill, per R3.
    """
    FloorPlan = apps.get_model('fm_generator', 'FloorPlan')
    FloorPlan.objects.all().delete()


class Migration(migrations.Migration):

    # Postgres refuses to ALTER TABLE a table within the same transaction
    # as a DELETE that fired pending FK-referential-integrity trigger
    # events on it ("cannot ALTER TABLE ... because it has pending trigger
    # events") -- and fm_generator_floorplan is both the target of the
    # RunPython delete below and the table the AddField below alters,
    # while also being FK-referenced by fm_generator_objects. Running this
    # migration non-atomically lets the delete commit in its own
    # transaction before the schema change runs in a separate one,
    # sidestepping that restriction. Confirmed necessary by actually
    # running this migration against the dev DB's pre-existing legacy
    # floor plan (id 1) and its objects.
    atomic = False

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('fm_generator', '0005_alter_objects_type'),
    ]

    operations = [
        # NOTE: This deletion is genuinely irreversible. There is no data
        # from which to reconstruct the deleted row(s) on a reverse
        # migration, so the reverse operation is intentionally a no-op
        # rather than an attempt to restore lost data.
        migrations.RunPython(delete_all_floor_plans, reverse_code=migrations.RunPython.noop),
        migrations.AddField(
            model_name='floorplan',
            name='owner',
            field=models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='floor_plans', to=settings.AUTH_USER_MODEL),
        ),
    ]
