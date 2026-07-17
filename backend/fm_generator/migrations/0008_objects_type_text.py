# Written by hand to match `makemigrations fm_generator --name
# objects_type_text` output exactly (the container's bind mount is not
# writable by the app user, so the generated file couldn't land on disk —
# same situation as 0007; the autodetector's plan was verified with
# `makemigrations --check --dry-run` to be this single AlterField expanding
# the `type` choices with U7's 14th value, 'text').

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('fm_generator', '0007_objects_group_key'),
    ]

    operations = [
        migrations.AlterField(
            model_name='objects',
            name='type',
            field=models.CharField(
                choices=[
                    ('outlines', 'Outlines'),
                    ('tables', 'Tables'),
                    ('doors', 'Doors'),
                    ('chairs', 'Chairs'),
                    ('furnitures', 'Furnitures'),
                    ('appliances', 'Appliances'),
                    ('lighting', 'Lighting'),
                    ('shape_rectangle', 'Shape: Rectangle'),
                    ('shape_square', 'Shape: Square'),
                    ('shape_circle', 'Shape: Circle'),
                    ('line_straight', 'Line: Straight'),
                    ('line_curved', 'Line: Curved'),
                    ('line_s_curve', 'Line: S-Curve'),
                    ('text', 'Text'),
                ],
                max_length=20,
            ),
        ),
    ]
