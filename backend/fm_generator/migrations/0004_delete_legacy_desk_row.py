from django.db import migrations


def delete_legacy_desk_row(apps, schema_editor):
    """Delete the legacy 'desk' typed test row created before the type
    taxonomy was expanded. 'desk' is not part of the new 13-value enum
    landing in the next migration, so it must be removed before that
    AlterField runs (Django's `choices=` is validation-layer only, not a
    DB constraint, so a leftover invalid value wouldn't fail at migration
    time -- only at read/render time).
    """
    Objects = apps.get_model('fm_generator', 'Objects')
    Objects.objects.filter(type='desk').delete()


class Migration(migrations.Migration):

    dependencies = [
        ('fm_generator', '0003_rename_label_to_name_add_z_index'),
    ]

    operations = [
        # NOTE: This deletion is genuinely irreversible. There is no data
        # from which to reconstruct the deleted row(s) on a reverse
        # migration, so the reverse operation is intentionally a no-op
        # rather than an attempt to restore lost data.
        migrations.RunPython(delete_legacy_desk_row, reverse_code=migrations.RunPython.noop),
    ]
