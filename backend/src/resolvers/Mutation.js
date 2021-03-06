const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { hasPermission } = require('../utils');
const { randomBytes } = require('crypto');
const { promisify } = require('util');
const mail = require('../mail');
const stripe = require('../stripe');

const mutations = {
  // Signup Mutations
  async signup(parent, args, ctx, info) {
    args.email = args.email.toLowerCase();
    const password = await bcrypt.hash(args.password, 10);
    const user = await ctx.db.mutation.createUser({
      data: {
        ...args,
        password,
        permissions: { set: ['USER'] },
      },
    });

    return {
      token: jwt.sign({ userId: user.id }, process.env.APP_SECRET),
      user,
    };
  },

  async signin(parent, { email, password }, ctx, info) {
    const user = await ctx.db.query.user({ where: { email } });
    if (!user) {
      throw new Error(`No such user found for email: ${email}`);
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      throw new Error('Invalid password');
    }
    return {
      token: jwt.sign({ userId: user.id }, process.env.APP_SECRET),
      user,
    };
  },

  // Create An Item
  async createItem(parent, args, ctx, info) {
    if (!ctx.request.userId) {
      throw new Error('You must be logged in to create an item');
    }

    const item = await ctx.db.mutation.createItem(
      {
        data: {
          user: {
            connect: {
              id: ctx.request.userId,
            },
          },
          ...args,
        },
      },
      info
    );
    return item;
  },

  async deleteItem(parent, args, ctx, info) {
    const where = {
      id: args.id,
    };
    // 1. find the item
    const item = await ctx.db.query.item({ where }, `{ user {id}, title, id, description }`);
    // 2. Make sure they own it, or are an admin
    if (item.user.id !== ctx.request.user.id || !ctx.request.user.permissions.includes('ADMIN')) {
      throw new Error("You aren't allowed to delete that item!");
    }

    // You Should Either Own this item, or have ITEMDELETE in roles
    return ctx.db.mutation.deleteItem({ where }, info);
  },

  async updateItem(parent, args, ctx, info) {
    const user = ctx.request.user;
    const item = await ctx.db.query.item({ where: { id: args.id } }, `{ user { id } }`);

    if (item.user.id !== user.id || !hasPermission(user, ['ADMIN'])) {
      throw new Error('You are not allowed to update that item!');
    }

    const updates = { ...args };
    // remove the ID because you can't update that
    delete updates.id;
    return ctx.db.mutation.updateItem(
      {
        where: { id: args.id },
        data: {
          ...updates,
        },
      },
      info
    );
  },

  // Send password request
  async requestReset(parent, args, ctx, info) {
    // 1. find if there is a user with that email
    const user = await ctx.db.query.user({ where: { email: args.email } });

    if (!user) {
      throw new Error(`No user with the email ${args.email}`);
    }
    // 2. Set a reset token, and a reset date
    const resetToken = (await promisify(randomBytes)(20)).toString('hex');
    const resetTokenExpiry = Date.now() + 3600000; // 1 hour from now
    console.log({ resetToken, resetTokenExpiry });
    const res = await ctx.db.mutation.updateUser({
      where: { email: args.email },
      data: { resetToken, resetTokenExpiry },
    });

    // 3. Send them their token via email
    const mailRes = await mail.transport.sendMail({
      from: 'wesbos@gmail.com',
      to: user.email,
      subject: 'Your password reset token',
      // TODO: don't hardcore localhost here
      html: mail.makeANiceEmail(
        `Your password reset link is here! \n\n<a href="${ctx.request.protocol}://${ctx.request.get(
          'host'
        )}/reset?resetToken=${resetToken}">Click Here to reset</a>s`
      ),
    });
    return res.updateUser;
  },

  async resetPassword(parent, args, ctx, info) {
    // 1. Check that the passwords match
    if (args.password !== args.confirmPassword) {
      throw new Error('Passwords do not match');
    }

    // 2. Check that this is a legit resetToken
    // 3. Check that it's not expired
    // Note: If we didn't need the user here, we could also use db.exists()
    const [user] = await ctx.db.query.users({
      where: {
        resetToken: args.resetToken,
        resetTokenExpiry_gte: Date.now() - 3600000, // within the last hour
      },
    });

    if (!user) {
      throw new Error('This token is either invalid or expired.');
    }

    // 4. Hash the password
    const password = await bcrypt.hash(args.password, 10);

    // 5. Update the users password
    // clean up the resetToken fields at the same time
    const updatedUser = await ctx.db.mutation.updateUser({
      where: { email: user.email },
      data: {
        password,
        resetToken: null,
        resetTokenExpiry: null,
      },
    });

    // 6. send back the Auth Payload for the GraphQL request on the client
    return {
      // TODO: This should use sub instead of userId
      token: jwt.sign({ userId: updatedUser.id }, process.env.APP_SECRET),
      user: updatedUser,
    };
  },
  /*
    Add to cart
  */
  async addToCart(parent, args, ctx, info) {
    const userId = ctx.request.userId;

    if (!userId) {
      throw new Error('You must be signed in to add to cart!');
    }

    // 1. Check if there is a CartItem for this user and item already
    const [existingCartItem] = await ctx.db.query.cartItems({
      where: {
        user: { id: userId },
        item: { id: args.id },
      },
    });

    if (existingCartItem) {
      return ctx.db.mutation.updateCartItem(
        {
          where: { id: existingCartItem.id },
          data: { quantity: existingCartItem.quantity + 1 },
        },
        info
      );
    }

    // Otherwise create a new cartItem
    return ctx.db.mutation.createCartItem(
      {
        data: {
          user: {
            connect: {
              id: userId,
            },
          },
          item: {
            connect: { id: args.id },
          },
        },
      },
      info
    );
  },

  // delete that cart item
  async removeFromCart(parent, args, ctx, info) {
    return ctx.db.mutation.deleteManyCartItems(
      {
        where: {
          id: args.id,
          user: {
            id: ctx.request.userId,
          },
        },
      },
      info
    );
  },

  async createOrder(parent, args, ctx, info) {
    const userId = ctx.request.userId;
    const user = await ctx.db.query.user(
      { where: { id: userId } },
      // TODO - can we just pass info here?
      '{ id, name, email, cart { id, quantity, item { title, price, id, description, image } }}'
    );
    // 1. Recalculate the total for the price
    const amount = user.cart.reduce(
      (tally, cartItem) => tally + cartItem.item.price * cartItem.quantity,
      0
    );
    // 2. Create a stripe charge
    const charge = await stripe.charges.create({
      amount,
      currency: 'usd',
      source: args.token,
    });

    // 3. convert the items they want to OrderItems
    const orderItems = user.cart.map(cartItem => {
      const orderItem = {
        quantity: cartItem.quantity,
        // copy all the item details so it's there forever
        ...cartItem.item,
        item: {
          // relationship to the Item incase we need it
          connect: { id: cartItem.item.id },
        },
        user: { connect: { id: user.id } },
      };
      // scrub the ID from it because the orderItem will have it's own ID
      delete orderItem.id;
      return orderItem;
    });

    // 4. Create the Order
    const order = await ctx.db.mutation.createOrder({
      data: {
        total: charge.amount,
        charge: charge.id,
        items: {
          // TODO this is going to be create instead
          create: orderItems,
        },
        user: {
          connect: {
            id: user.id,
          },
        },
      },
    });

    // 5. Clean up, clear the users cart and send back { user, order }
    // Delete the users current cart items
    const cartItemIds = user.cart.map(cartItem => cartItem.id);
    await ctx.db.mutation.deleteManyCartItems({
      where: {
        id_in: cartItemIds,
      },
    });

    // 6. Send the order back to the client
    return order;
  },

  async updateUser(parent, args, ctx, info) {
    const userId = ctx.request.userId;
    const updatedUser = await ctx.db.mutation.updateUser(
      {
        data: args,
        where: { id: userId },
      },
      info
    );
    return updatedUser;
  },

  async updatePermissions(parent, args, ctx, info) {
    const userId = ctx.request.userId;
    const currentUser = await ctx.db.query.user({ where: { id: userId } }, info);
    if (!currentUser) throw new Error('You Must be logged in to updat permissions!');
    hasPermission(currentUser, ['ADMIN', 'PERMISSIONUPDATE']);
    return ctx.db.mutation.updateUser(
      {
        data: {
          permissions: {
            set: args.permissions,
          },
        },
        where: { id: args.userId },
      },
      info
    );
  },
};

module.exports = mutations;
