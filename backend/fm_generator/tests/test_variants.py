"""Model-level tests for ObjectVariant (U1, object-visuals).

Covers the storage-path contract (per-owner UUID names, kind-derived
extension, no client-filename leakage), the catalog-only `object_type`
restriction, and `original_name`'s display-only independence from the
stored path. API/pipeline behavior (upload validation, quota, soft-delete
routes) belongs to U2/U3 and is NOT tested here.
"""

import shutil
import tempfile

from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings

from accounts.models import User
from fm_generator.models import ObjectVariant, Objects, variant_upload_to

VALID_PASSWORD = 'Correct-Horse-9427!'

# Anything storage-touching runs against a throwaway MEDIA_ROOT so tests
# never write into the real (compose-mounted) media volume. Shared by every
# class in this module; removed once, after all of them (tearDownModule).
TEST_MEDIA_ROOT = tempfile.mkdtemp(prefix='floorcraft-test-media-')


def tearDownModule():
    shutil.rmtree(TEST_MEDIA_ROOT, ignore_errors=True)

CATALOG_TYPES = [value for value, _label in ObjectVariant.CATALOG_TYPE_CHOICES]
NON_CATALOG_OBJECT_TYPES = [
    value for value, _label in Objects.ObjectType.choices
    if value not in CATALOG_TYPES
]

# uploads/user_<owner_id>/<uuid4hex>.<kind>
UPLOAD_PATH_RE = r'^uploads/user_{owner_id}/[0-9a-f]{{32}}\.{ext}$'


def make_verified_user(email='verified@example.com', password=VALID_PASSWORD):
    user = User.objects.create_user(email=email, password=password)
    user.is_active = True
    user.save()
    return user


def variant_kwargs(owner, **overrides):
    """A minimal valid ObjectVariant creation payload."""
    kwargs = {
        'owner': owner,
        'object_type': Objects.ObjectType.CHAIRS,
        'file': SimpleUploadedFile('fancy chair.png', b'png-bytes'),
        'kind': ObjectVariant.Kind.PNG,
        'width': 64,
        'height': 48,
        'size_bytes': 9,
        'original_name': 'fancy chair.png',
    }
    kwargs.update(overrides)
    return kwargs


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class VariantUploadPathTests(TestCase):
    """The variant_upload_to contract: per-owner directory, UUID name,
    extension from the sniffed `kind` — never the client filename, never
    the variant's own pk.
    """

    def setUp(self):
        self.user = make_verified_user()

    def test_upload_to_produces_owner_scoped_uuid_path(self):
        variant = ObjectVariant(owner=self.user, kind=ObjectVariant.Kind.PNG)

        path = variant_upload_to(variant, 'client supplied name.png')

        self.assertRegex(
            path,
            UPLOAD_PATH_RE.format(owner_id=self.user.id, ext='png'),
        )

    def test_upload_to_extension_tracks_kind_not_client_filename(self):
        # The client filename claims .png every time; the extension must
        # follow the row's sniffed kind instead.
        for kind in ObjectVariant.Kind:
            variant = ObjectVariant(owner=self.user, kind=kind)

            path = variant_upload_to(variant, 'claims-to-be.png')

            self.assertTrue(path.endswith(f'.{kind.value}'), (kind, path))

    def test_upload_to_ignores_client_filename_entirely(self):
        variant = ObjectVariant(owner=self.user, kind=ObjectVariant.Kind.SVG)

        path = variant_upload_to(variant, '../../../etc/passwd \x00 <img>.svg')

        self.assertRegex(
            path,
            UPLOAD_PATH_RE.format(owner_id=self.user.id, ext='svg'),
        )
        self.assertNotIn('..', path)
        self.assertNotIn('passwd', path)

    def test_upload_to_keys_off_owner_id_not_variant_pk(self):
        # upload_to runs before the row is saved — the variant's own pk
        # must play no part in the path (it does not exist yet).
        variant = ObjectVariant(owner=self.user, kind=ObjectVariant.Kind.JPEG)
        self.assertIsNone(variant.pk)

        path = variant_upload_to(variant, 'photo.jpeg')

        self.assertRegex(
            path,
            UPLOAD_PATH_RE.format(owner_id=self.user.id, ext='jpeg'),
        )

    def test_created_variant_stores_uuid_named_file_under_owner_directory(self):
        variant = ObjectVariant.objects.create(**variant_kwargs(self.user))

        variant.refresh_from_db()
        self.assertRegex(
            variant.file.name,
            UPLOAD_PATH_RE.format(owner_id=self.user.id, ext='png'),
        )
        # The bytes actually landed under the temp MEDIA_ROOT.
        with variant.file.open('rb') as stored:
            self.assertEqual(stored.read(), b'png-bytes')

    def test_two_uploads_never_share_a_path(self):
        first = ObjectVariant.objects.create(**variant_kwargs(self.user))
        second = ObjectVariant.objects.create(**variant_kwargs(self.user))

        self.assertNotEqual(first.file.name, second.file.name)

    def test_owners_get_distinct_directories(self):
        other = make_verified_user(email='other@example.com')

        mine = ObjectVariant.objects.create(**variant_kwargs(self.user))
        theirs = ObjectVariant.objects.create(**variant_kwargs(other))

        self.assertIn(f'user_{self.user.id}/', mine.file.name)
        self.assertIn(f'user_{other.id}/', theirs.file.name)


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class VariantOriginalNameTests(TestCase):
    """`original_name` is display-only: preserved verbatim on the row and
    entirely absent from the storage path.
    """

    def setUp(self):
        self.user = make_verified_user()

    def test_original_name_stored_independently_of_file_path(self):
        variant = ObjectVariant.objects.create(**variant_kwargs(self.user))

        variant.refresh_from_db()
        self.assertEqual(variant.original_name, 'fancy chair.png')
        self.assertNotIn('fancy', variant.file.name)
        self.assertNotIn('chair', variant.file.name)


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class VariantObjectTypeTests(TestCase):
    """`object_type` accepts exactly the 7 catalog types — shape/line/text
    values from the wider Objects taxonomy (and garbage) are rejected.
    """

    def setUp(self):
        self.user = make_verified_user()

    def build_variant(self, object_type):
        return ObjectVariant(**variant_kwargs(self.user, object_type=object_type))

    def test_all_seven_catalog_types_validate(self):
        self.assertEqual(len(CATALOG_TYPES), 7)

        for object_type in CATALOG_TYPES:
            variant = self.build_variant(object_type)
            variant.full_clean()  # must not raise

    def test_non_catalog_taxonomy_values_are_rejected(self):
        # Every Objects.ObjectType member OUTSIDE the catalog seven
        # (shapes, lines, text) is an invalid variant type.
        self.assertEqual(len(NON_CATALOG_OBJECT_TYPES), 7)

        for object_type in NON_CATALOG_OBJECT_TYPES:
            variant = self.build_variant(object_type)
            with self.assertRaises(ValidationError, msg=object_type) as ctx:
                variant.full_clean()
            self.assertIn('object_type', ctx.exception.message_dict)

    def test_garbage_object_type_is_rejected(self):
        variant = self.build_variant('desk')

        with self.assertRaises(ValidationError) as ctx:
            variant.full_clean()
        self.assertIn('object_type', ctx.exception.message_dict)


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class VariantDefaultsTests(TestCase):
    """Row-level defaults: variants are born active (soft delete is the
    R11 mechanism and only ever flips this flag), with a creation stamp.
    """

    def setUp(self):
        self.user = make_verified_user()

    def test_new_variant_is_active_with_created_at(self):
        variant = ObjectVariant.objects.create(**variant_kwargs(self.user))

        variant.refresh_from_db()
        self.assertTrue(variant.is_active)
        self.assertIsNotNone(variant.created_at)

    def test_owner_relation_exposes_object_variants(self):
        variant = ObjectVariant.objects.create(**variant_kwargs(self.user))

        self.assertIn(variant, self.user.object_variants.all())
