import { Column, Entity } from 'typeorm'

@Entity()
export class User {
  @Column()
  name!: string
}
