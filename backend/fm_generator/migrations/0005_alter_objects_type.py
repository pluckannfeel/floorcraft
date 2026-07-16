from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('fm_generator', '0004_delete_legacy_desk_row'),
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
                ],
                max_length=20,
            ),
        ),
    ]
