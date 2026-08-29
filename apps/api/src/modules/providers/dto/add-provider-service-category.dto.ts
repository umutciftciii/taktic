import { IsNotEmpty, IsString } from 'class-validator';

/**
 * The one thing binding a provider to a category needs: which category.
 *
 * The provider is a path parameter and the actor is the session, so nothing a
 * caller writes into this body decides who is being changed or by whom. What
 * the category is allowed to be — an ACTIVE or DRAFT leaf, never a group, a
 * router or a closed category — is a taxonomy rule and is checked against the
 * stored row, never against anything sent here.
 */
export class AddProviderServiceCategoryDto {
  @IsString()
  @IsNotEmpty()
  categoryId!: string;
}
