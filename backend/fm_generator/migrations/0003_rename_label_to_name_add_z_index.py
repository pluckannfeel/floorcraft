from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('fm_generator', '0002_rename_floorplanitem_objects'),
    ]

    operations = [
        migrations.RenameField(
            model_name='objects',
            old_name='label',
            new_name='name',
        ),
        migrations.AddField(
            model_name='objects',
            name='z_index',
            field=models.IntegerField(default=0, db_index=True),
        ),
    ]
