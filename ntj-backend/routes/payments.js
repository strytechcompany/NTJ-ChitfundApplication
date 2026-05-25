const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { protect } = require('../middleware/auth');
const Order = require('../models/Order');
const User = require('../models/User');
const { sendPaymentBillEmail } = require('../services/emailService');

// Lazy Razorpay initialisation — avoids crashing the server at startup
// when RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not yet configured.
let _razorpay = null;
const getRazorpay = () => {
    if (!_razorpay) {
        const keyId = process.env.RAZORPAY_KEY_ID;
        const keySecret = process.env.RAZORPAY_KEY_SECRET;
        if (!keyId || keyId === 'rzp_test_PLACEHOLDER' || !keySecret || keySecret === 'PLACEHOLDER_secret') {
            throw new Error('Razorpay keys are not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in your .env file.');
        }
        _razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    }
    return _razorpay;
};

// @route   POST /api/payments/razorpay/create-order
// @desc    Create Razorpay order
// @access  Private
router.post('/razorpay/create-order', protect, async (req, res) => {
    try {
        const { amount, metalType, metalName, grams, rate } = req.body;

        if (!amount || !metalType || !grams || !rate) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }

        // Create Razorpay order
        const options = {
            amount: Math.round(amount * 100), // amount in paise
            currency: 'INR',
            receipt: `order_${Date.now()}`,
            notes: {
                userId: req.user._id.toString(),
                metalType,
                grams,
                rate
            }
        };

        const razorpayOrder = await getRazorpay().orders.create(options);

        // Create order in database with Pending status
        const order = await Order.create({
            userId: req.user._id,
            metalType,
            metalName: metalName || (metalType === 'gold' ? 'Gold (XAU)' : 'Silver (XAG)'),
            orderId: razorpayOrder.id,
            amountPaid: amount,
            ratePerGram: rate,
            gramsCredited: grams,
            status: 'Pending'
        });

        res.json({
            success: true,
            data: {
                orderId: razorpayOrder.id,
                amount: razorpayOrder.amount,
                currency: razorpayOrder.currency,
                dbOrderId: order._id
            }
        });
    } catch (error) {
        console.error('Create order error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create order',
            error: error.message
        });
    }
});

// @route   POST /api/payments/razorpay/verify
// @desc    Verify Razorpay payment
// @access  Private
router.post('/razorpay/verify', protect, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({
                success: false,
                message: 'Missing payment verification data'
            });
        }

        // Verify signature
        const body = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest('hex');

        const isAuthentic = expectedSignature === razorpay_signature;

        if (isAuthentic) {
            // Update order status
            const order = await Order.findOne({ orderId: razorpay_order_id });

            if (order) {
                order.status = 'Success';
                order.paymentId = razorpay_payment_id;
                order.razorpaySignature = razorpay_signature;
                await order.save();

                // Update user's gold/silver balance
                const user = await User.findById(order.userId);
                if (order.metalType === 'gold') {
                    user.goldBalance += order.gramsCredited;
                } else {
                    user.silverBalance += order.gramsCredited;
                }
                await user.save();

                // ── Send purchase bill email to user ───────────────────────
                if (user?.email) {
                    sendPaymentBillEmail({
                        toEmail: user.email,
                        customerName: user.name || 'Valued Customer',
                        order: order.toObject ? order.toObject() : order,
                    }).catch(err => console.error('Bill email error (non-fatal):', err.message));
                }

                res.json({
                    success: true,
                    message: 'Payment verified successfully',
                    data: {
                        orderId: razorpay_order_id,
                        paymentId: razorpay_payment_id,
                        order: order
                    }
                });
            } else {
                res.status(404).json({
                    success: false,
                    message: 'Order not found'
                });
            }
        } else {
            res.status(400).json({
                success: false,
                message: 'Payment verification failed'
            });
        }
    } catch (error) {
        console.error('Verify payment error:', error);
        res.status(500).json({
            success: false,
            message: 'Error verifying payment',
            error: error.message
        });
    }
});

module.exports = router;
