from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('fm_generator', '0001_initial'),
    ]

    operations = [
        migrations.RenameModel(
            old_name='FloorPlanItem',
            new_name='Objects',
        ),
    ]
