import { router, authMiddleware } from './r'

router.get('/users', authMiddleware, (req, res) => res.json({}))
